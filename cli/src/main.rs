mod builder_types;
mod place_wisp;
mod cid;
mod blob_map;
mod metadata;
mod download;
mod pull;
mod serve;
mod subfs_utils;
mod redirects;
mod ignore_patterns;

use clap::{Parser, Subcommand};
use jacquard::CowStr;
use jacquard::client::{Agent, FileAuthStore, AgentSessionExt, MemoryCredentialSession, AgentSession};
use jacquard::oauth::client::OAuthClient;
use jacquard::oauth::loopback::LoopbackConfig;
use jacquard::prelude::IdentityResolver;
use jacquard_common::types::string::{Datetime, Rkey, RecordKey, AtUri};
use jacquard_common::types::blob::MimeType;
use miette::IntoDiagnostic;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;
use base64::Engine;
use futures::stream::{self, StreamExt};
use indicatif::{ProgressBar, ProgressStyle, MultiProgress};

use place_wisp::fs::*;
use place_wisp::settings::*;

/// Maximum number of concurrent file uploads to the PDS
const MAX_CONCURRENT_UPLOADS: usize = 2;

/// Limits for caching on wisp.place (from @wisp/constants)
const MAX_FILE_COUNT: usize = 1000;
const MAX_SITE_SIZE: usize = 300 * 1024 * 1024; // 300MB

#[derive(Parser, Debug)]
#[command(author, version, about = "wisp.place CLI tool")]
struct Args {
    #[command(subcommand)]
    command: Option<Commands>,
    
    // Deploy arguments (when no subcommand is specified)
    /// Handle (e.g., alice.bsky.social), DID, or PDS URL
    #[arg(global = true, conflicts_with = "command")]
    input: Option<CowStr<'static>>,

    /// Path to the directory containing your static site
    #[arg(short, long, global = true, conflicts_with = "command")]
    path: Option<PathBuf>,

    /// Site name (defaults to directory name)
    #[arg(short, long, global = true, conflicts_with = "command")]
    site: Option<String>,

    /// Path to auth store file
    #[arg(long, global = true, conflicts_with = "command")]
    store: Option<String>,

    /// App Password for authentication
    #[arg(long, global = true, conflicts_with = "command")]
    password: Option<CowStr<'static>>,

    /// Enable directory listing mode for paths without index files
    #[arg(long, global = true, conflicts_with = "command")]
    directory: bool,

    /// Enable SPA mode (serve index.html for all routes)
    #[arg(long, global = true, conflicts_with = "command")]
    spa: bool,

    /// Skip confirmation prompts (automatically accept warnings)
    #[arg(short = 'y', long, global = true, conflicts_with = "command")]
    yes: bool,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Deploy a static site to wisp.place (default command)
    Deploy {
        /// Handle (e.g., alice.bsky.social), DID, or PDS URL
        input: CowStr<'static>,

        /// Path to the directory containing your static site
        #[arg(short, long, default_value = ".")]
        path: PathBuf,

        /// Site name (defaults to directory name)
        #[arg(short, long)]
        site: Option<String>,

        /// Path to auth store file (will be created if missing, only used with OAuth)
        #[arg(long, default_value = "/tmp/wisp-oauth-session.json")]
        store: String,

        /// App Password for authentication (alternative to OAuth)
        #[arg(long)]
        password: Option<CowStr<'static>>,

        /// Enable directory listing mode for paths without index files
        #[arg(long)]
        directory: bool,

        /// Enable SPA mode (serve index.html for all routes)
        #[arg(long)]
        spa: bool,

        /// Skip confirmation prompts (automatically accept warnings)
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Pull a site from the PDS to a local directory
    Pull {
        /// Handle (e.g., alice.bsky.social) or DID
        input: CowStr<'static>,

        /// Site name (record key)
        #[arg(short, long)]
        site: String,

        /// Output directory for the downloaded site
        #[arg(short, long, default_value = ".")]
        output: PathBuf,
    },
    /// Serve a site locally with real-time firehose updates
    Serve {
        /// Handle (e.g., alice.bsky.social) or DID
        input: CowStr<'static>,

        /// Site name (record key)
        #[arg(short, long)]
        site: String,

        /// Output directory for the site files
        #[arg(short, long, default_value = ".")]
        output: PathBuf,

        /// Port to serve on
        #[arg(short, long, default_value = "8080")]
        port: u16,
    },
}

#[tokio::main]
async fn main() -> miette::Result<()> {
    let args = Args::parse();

    let result = match args.command {
        Some(Commands::Deploy { input, path, site, store, password, directory, spa, yes }) => {
            // Dispatch to appropriate authentication method
            if let Some(password) = password {
                run_with_app_password(input, password, path, site, directory, spa, yes).await
            } else {
                run_with_oauth(input, store, path, site, directory, spa, yes).await
            }
        }
        Some(Commands::Pull { input, site, output }) => {
            pull::pull_site(input, CowStr::from(site), output).await
        }
        Some(Commands::Serve { input, site, output, port }) => {
            serve::serve_site(input, CowStr::from(site), output, port).await
        }
        None => {
            // Legacy mode: if input is provided, assume deploy command
            if let Some(input) = args.input {
                let path = args.path.unwrap_or_else(|| PathBuf::from("."));
                let store = args.store.unwrap_or_else(|| "/tmp/wisp-oauth-session.json".to_string());

                // Dispatch to appropriate authentication method
                if let Some(password) = args.password {
                    run_with_app_password(input, password, path, args.site, args.directory, args.spa, args.yes).await
                } else {
                    run_with_oauth(input, store, path, args.site, args.directory, args.spa, args.yes).await
                }
            } else {
                // No command and no input, show help
                use clap::CommandFactory;
                Args::command().print_help().into_diagnostic()?;
                Ok(())
            }
        }
    };

    // Force exit to avoid hanging on background tasks/connections
    match result {
        Ok(_) => std::process::exit(0),
        Err(e) => {
            eprintln!("{:?}", e);
            std::process::exit(1)
        }
    }
}

/// Run deployment with app password authentication
async fn run_with_app_password(
    input: CowStr<'static>,
    password: CowStr<'static>,
    path: PathBuf,
    site: Option<String>,
    directory: bool,
    spa: bool,
    yes: bool,
) -> miette::Result<()> {
    let (session, auth) =
        MemoryCredentialSession::authenticated(input, password, None, None).await?;
    println!("Signed in as {}", auth.handle);

    let agent: Agent<_> = Agent::from(session);
    deploy_site(&agent, path, site, directory, spa, yes).await
}

/// Run deployment with OAuth authentication
async fn run_with_oauth(
    input: CowStr<'static>,
    store: String,
    path: PathBuf,
    site: Option<String>,
    directory: bool,
    spa: bool,
    yes: bool,
) -> miette::Result<()> {
    use jacquard::oauth::scopes::Scope;
    use jacquard::oauth::atproto::AtprotoClientMetadata;
    use jacquard::oauth::session::ClientData;
    use url::Url;

    // Request the necessary scopes for wisp.place (including settings)
    let scopes = Scope::parse_multiple("atproto repo:place.wisp.fs repo:place.wisp.subfs repo:place.wisp.settings blob:*/*")
        .map_err(|e| miette::miette!("Failed to parse scopes: {:?}", e))?;

    // Create redirect URIs that match the loopback server (port 4000, path /oauth/callback)
    let redirect_uris = vec![
        Url::parse("http://127.0.0.1:4000/oauth/callback").into_diagnostic()?,
        Url::parse("http://[::1]:4000/oauth/callback").into_diagnostic()?,
    ];

    // Create client metadata with matching redirect URIs and scopes
    let client_data = ClientData {
        keyset: None,
        config: AtprotoClientMetadata::new_localhost(
            Some(redirect_uris),
            Some(scopes),
        ),
    };

    let oauth = OAuthClient::new(FileAuthStore::new(&store), client_data);

    let session = oauth
        .login_with_local_server(input, Default::default(), LoopbackConfig::default())
        .await?;

    let agent: Agent<_> = Agent::from(session);
    deploy_site(&agent, path, site, directory, spa, yes).await
}

/// Scan directory to count files and calculate total size
/// Returns (file_count, total_size_bytes)
fn scan_directory_stats(
    dir_path: &Path,
    ignore_matcher: &ignore_patterns::IgnoreMatcher,
    current_path: String,
) -> miette::Result<(usize, u64)> {
    let mut file_count = 0;
    let mut total_size = 0u64;

    let dir_entries: Vec<_> = std::fs::read_dir(dir_path)
        .into_diagnostic()?
        .collect::<Result<Vec<_>, _>>()
        .into_diagnostic()?;

    for entry in dir_entries {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_str()
            .ok_or_else(|| miette::miette!("Invalid filename: {:?}", name))?
            .to_string();

        let full_path = if current_path.is_empty() {
            name_str.clone()
        } else {
            format!("{}/{}", current_path, name_str)
        };

        // Skip files/directories that match ignore patterns
        if ignore_matcher.is_ignored(&full_path) || ignore_matcher.is_filename_ignored(&name_str) {
            continue;
        }

        let metadata = entry.metadata().into_diagnostic()?;

        if metadata.is_file() {
            file_count += 1;
            total_size += metadata.len();
        } else if metadata.is_dir() {
            let subdir_path = if current_path.is_empty() {
                name_str
            } else {
                format!("{}/{}", current_path, name_str)
            };
            let (sub_count, sub_size) = scan_directory_stats(&path, ignore_matcher, subdir_path)?;
            file_count += sub_count;
            total_size += sub_size;
        }
    }

    Ok((file_count, total_size))
}

/// Deploy the site using the provided agent
async fn deploy_site(
    agent: &Agent<impl jacquard::client::AgentSession + IdentityResolver>,
    path: PathBuf,
    site: Option<String>,
    directory_listing: bool,
    spa_mode: bool,
    skip_prompts: bool,
) -> miette::Result<()> {
    // Verify the path exists
    if !path.exists() {
        return Err(miette::miette!("Path does not exist: {}", path.display()));
    }

    // Get site name
    let site_name = site.unwrap_or_else(|| {
        path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("site")
            .to_string()
    });

    println!("Deploying site '{}'...", site_name);

    // Scan directory to check file count and size
    let ignore_matcher = ignore_patterns::IgnoreMatcher::new(&path)?;
    let (file_count, total_size) = scan_directory_stats(&path, &ignore_matcher, String::new())?;

    let size_mb = total_size as f64 / (1024.0 * 1024.0);
    println!("Scanned: {} files, {:.1} MB total", file_count, size_mb);

    // Check if limits are exceeded
    let exceeds_file_count = file_count > MAX_FILE_COUNT;
    let exceeds_size = total_size > MAX_SITE_SIZE as u64;

    if exceeds_file_count || exceeds_size {
        println!("\n⚠️  Warning: Your site exceeds wisp.place caching limits:");

        if exceeds_file_count {
            println!("  • File count: {} (limit: {})", file_count, MAX_FILE_COUNT);
        }

        if exceeds_size {
            let size_mb = total_size as f64 / (1024.0 * 1024.0);
            let limit_mb = MAX_SITE_SIZE as f64 / (1024.0 * 1024.0);
            println!("  • Total size: {:.1} MB (limit: {:.0} MB)", size_mb, limit_mb);
        }

        println!("\nwisp.place will NOT serve your site if you proceed.");
        println!("Your site will be uploaded to your PDS, but will only be accessible via:");
        println!("  • wisp-cli serve (local hosting)");
        println!("  • Other hosting services with more generous limits");

        if !skip_prompts {
            // Prompt for confirmation
            use std::io::{self, Write};
            print!("\nDo you want to upload anyway? (y/N): ");
            io::stdout().flush().into_diagnostic()?;

            let mut input = String::new();
            io::stdin().read_line(&mut input).into_diagnostic()?;
            let input = input.trim().to_lowercase();

            if input != "y" && input != "yes" {
                println!("Upload cancelled.");
                return Ok(());
            }
        } else {
            println!("\nSkipping confirmation (--yes flag set).");
        }

        println!("\nProceeding with upload...\n");
    }

    // Try to fetch existing manifest for incremental updates
    let (existing_blob_map, old_subfs_uris): (HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)>, Vec<(String, String)>) = {
        use jacquard_common::types::string::AtUri;

        // Get the DID for this session
        let session_info = agent.session_info().await;
        if let Some((did, _)) = session_info {
            // Construct the AT URI for the record
            let uri_string = format!("at://{}/place.wisp.fs/{}", did, site_name);
            if let Ok(uri) = AtUri::new(&uri_string) {
                match agent.get_record::<Fs>(&uri).await {
                    Ok(response) => {
                        match response.into_output() {
                            Ok(record_output) => {
                                let existing_manifest = record_output.value;
                                let mut blob_map = blob_map::extract_blob_map(&existing_manifest.root);
                                println!("Found existing manifest with {} files in main record", blob_map.len());

                                // Extract subfs URIs from main record
                                let subfs_uris = subfs_utils::extract_subfs_uris(&existing_manifest.root, String::new());

                                if !subfs_uris.is_empty() {
                                    println!("Found {} subfs records, fetching for blob reuse...", subfs_uris.len());

                                    // Merge blob maps from all subfs records
                                    match subfs_utils::merge_subfs_blob_maps(agent, subfs_uris.clone(), &mut blob_map).await {
                                        Ok(merged_count) => {
                                            println!("Total blob map: {} files (main + {} from subfs)", blob_map.len(), merged_count);
                                        }
                                        Err(e) => {
                                            eprintln!("⚠️  Failed to merge some subfs blob maps: {}", e);
                                        }
                                    }

                                    (blob_map, subfs_uris)
                                } else {
                                    (blob_map, Vec::new())
                                }
                            }
                            Err(_) => {
                                println!("No existing manifest found, uploading all files...");
                                (HashMap::new(), Vec::new())
                            }
                        }
                    }
                    Err(_) => {
                        // Record doesn't exist yet - this is a new site
                        println!("No existing manifest found, uploading all files...");
                        (HashMap::new(), Vec::new())
                    }
                }
            } else {
                println!("No existing manifest found (invalid URI), uploading all files...");
                (HashMap::new(), Vec::new())
            }
        } else {
            println!("No existing manifest found (could not get DID), uploading all files...");
            (HashMap::new(), Vec::new())
        }
    };

    // Create progress tracking (spinner style since we don't know total count upfront)
    let multi_progress = MultiProgress::new();
    let progress = multi_progress.add(ProgressBar::new_spinner());
    progress.set_style(
        ProgressStyle::default_spinner()
            .template("[{elapsed_precise}] {spinner:.cyan} {pos} files {msg}")
            .into_diagnostic()?
            .tick_chars("⠁⠂⠄⡀⢀⠠⠐⠈ ")
    );
    progress.set_message("Scanning files...");
    progress.enable_steady_tick(std::time::Duration::from_millis(100));

    let (root_dir, total_files, reused_count) = build_directory(agent, &path, &existing_blob_map, String::new(), &ignore_matcher, &progress).await?;
    let uploaded_count = total_files - reused_count;

    progress.finish_with_message(format!("✓ {} files ({} uploaded, {} reused)", total_files, uploaded_count, reused_count));

    // Check if we need to split into subfs records
    const MAX_MANIFEST_SIZE: usize = 140 * 1024; // 140KB (PDS limit is 150KB)
    const FILE_COUNT_THRESHOLD: usize = 250; // Start splitting at this many files
    const TARGET_FILE_COUNT: usize = 200; // Keep main manifest under this

    let mut working_directory = root_dir;
    let mut current_file_count = total_files;
    let mut new_subfs_uris: Vec<(String, String)> = Vec::new();

    // Estimate initial manifest size
    let mut manifest_size = subfs_utils::estimate_directory_size(&working_directory);

    if total_files >= FILE_COUNT_THRESHOLD || manifest_size > MAX_MANIFEST_SIZE {
        println!("\n⚠️  Large site detected ({} files, {:.1}KB manifest), splitting into subfs records...",
            total_files, manifest_size as f64 / 1024.0);

        let mut attempts = 0;
        const MAX_SPLIT_ATTEMPTS: usize = 50;

        while (manifest_size > MAX_MANIFEST_SIZE || current_file_count > TARGET_FILE_COUNT) && attempts < MAX_SPLIT_ATTEMPTS {
            attempts += 1;

            // Find large directories to split
            let directories = subfs_utils::find_large_directories(&working_directory, String::new());

            if let Some(largest_dir) = directories.first() {
                println!("  Split #{}: {} ({} files, {:.1}KB)",
                    attempts, largest_dir.path, largest_dir.file_count, largest_dir.size as f64 / 1024.0);

                // Check if this directory is itself too large for a single subfs record
                const MAX_SUBFS_SIZE: usize = 75 * 1024; // 75KB soft limit for safety
                let mut subfs_uri = String::new();

                if largest_dir.size > MAX_SUBFS_SIZE {
                    // Need to split this directory into multiple chunks
                    println!("  → Directory too large, splitting into chunks...");
                    let chunks = subfs_utils::split_directory_into_chunks(&largest_dir.directory, MAX_SUBFS_SIZE);
                    println!("  → Created {} chunks", chunks.len());

                    // Upload each chunk as a subfs record
                    let mut chunk_uris = Vec::new();
                    for (i, chunk) in chunks.iter().enumerate() {
                        use jacquard_common::types::string::Tid;
                        let chunk_tid = Tid::now_0();
                        let chunk_rkey = chunk_tid.to_string();

                        let chunk_file_count = subfs_utils::count_files_in_directory(chunk);
                        let chunk_size = subfs_utils::estimate_directory_size(chunk);

                        let chunk_manifest = crate::place_wisp::subfs::SubfsRecord::new()
                            .root(convert_fs_dir_to_subfs_dir(chunk.clone()))
                            .file_count(Some(chunk_file_count as i64))
                            .created_at(Datetime::now())
                            .build();

                        println!("  → Uploading chunk {}/{} ({} files, {:.1}KB)...",
                            i + 1, chunks.len(), chunk_file_count, chunk_size as f64 / 1024.0);

                        let chunk_output = agent.put_record(
                            RecordKey::from(Rkey::new(&chunk_rkey).into_diagnostic()?),
                            chunk_manifest
                        ).await.into_diagnostic()?;

                        let chunk_uri = chunk_output.uri.to_string();
                        chunk_uris.push((chunk_uri.clone(), format!("{}#{}", largest_dir.path, i)));
                        new_subfs_uris.push((chunk_uri.clone(), format!("{}#{}", largest_dir.path, i)));
                    }

                    // Create a parent subfs record that references all chunks
                    // Each chunk reference MUST have flat: true to merge chunk contents
                    println!("  → Creating parent subfs with {} chunk references...", chunk_uris.len());
                    use jacquard_common::CowStr;
                    use crate::place_wisp::fs::{Subfs};

                    // Convert to fs::Subfs (which has the 'flat' field) instead of subfs::Subfs
                    let parent_entries_fs: Vec<Entry> = chunk_uris.iter().enumerate().map(|(i, (uri, _))| {
                        let uri_string = uri.clone();
                        let at_uri = AtUri::new_cow(CowStr::from(uri_string)).expect("valid URI");
                        Entry::new()
                            .name(CowStr::from(format!("chunk{}", i)))
                            .node(EntryNode::Subfs(Box::new(
                                Subfs::new()
                                    .r#type(CowStr::from("subfs"))
                                    .subject(at_uri)
                                    .flat(Some(true)) // EXPLICITLY TRUE - merge chunk contents
                                    .build()
                            )))
                            .build()
                    }).collect();

                    let parent_root_fs = Directory::new()
                        .r#type(CowStr::from("directory"))
                        .entries(parent_entries_fs)
                        .build();

                    // Convert to subfs::Directory for the parent subfs record
                    let parent_root_subfs = convert_fs_dir_to_subfs_dir(parent_root_fs);

                    use jacquard_common::types::string::Tid;
                    let parent_tid = Tid::now_0();
                    let parent_rkey = parent_tid.to_string();

                    let parent_manifest = crate::place_wisp::subfs::SubfsRecord::new()
                        .root(parent_root_subfs)
                        .file_count(Some(largest_dir.file_count as i64))
                        .created_at(Datetime::now())
                        .build();

                    let parent_output = agent.put_record(
                        RecordKey::from(Rkey::new(&parent_rkey).into_diagnostic()?),
                        parent_manifest
                    ).await.into_diagnostic()?;

                    subfs_uri = parent_output.uri.to_string();
                    println!("  ✅ Created parent subfs with chunks (flat=true on each chunk): {}", subfs_uri);
                } else {
                    // Directory fits in a single subfs record
                    use jacquard_common::types::string::Tid;
                    let subfs_tid = Tid::now_0();
                    let subfs_rkey = subfs_tid.to_string();

                    let subfs_manifest = crate::place_wisp::subfs::SubfsRecord::new()
                        .root(convert_fs_dir_to_subfs_dir(largest_dir.directory.clone()))
                        .file_count(Some(largest_dir.file_count as i64))
                        .created_at(Datetime::now())
                        .build();

                    // Upload subfs record
                    let subfs_output = agent.put_record(
                        RecordKey::from(Rkey::new(&subfs_rkey).into_diagnostic()?),
                        subfs_manifest
                    ).await.into_diagnostic()?;

                    subfs_uri = subfs_output.uri.to_string();
                    println!("  ✅ Created subfs: {}", subfs_uri);
                }

                // Replace directory with subfs node (flat: false to preserve directory structure)
                working_directory = subfs_utils::replace_directory_with_subfs(
                    working_directory,
                    &largest_dir.path,
                    &subfs_uri,
                    false // Preserve directory - the chunks inside have flat=true
                )?;

                new_subfs_uris.push((subfs_uri, largest_dir.path.clone()));
                current_file_count -= largest_dir.file_count;

                // Recalculate manifest size
                manifest_size = subfs_utils::estimate_directory_size(&working_directory);
                println!("  → Manifest now {:.1}KB with {} files ({} subfs total)",
                    manifest_size as f64 / 1024.0, current_file_count, new_subfs_uris.len());

                if manifest_size <= MAX_MANIFEST_SIZE && current_file_count <= TARGET_FILE_COUNT {
                    println!("✅ Manifest now fits within limits");
                    break;
                }
            } else {
                println!("  No more subdirectories to split - stopping");
                break;
            }
        }

        if attempts >= MAX_SPLIT_ATTEMPTS {
            return Err(miette::miette!(
                "Exceeded maximum split attempts ({}). Manifest still too large: {:.1}KB with {} files",
                MAX_SPLIT_ATTEMPTS,
                manifest_size as f64 / 1024.0,
                current_file_count
            ));
        }

        println!("✅ Split complete: {} subfs records, {} files in main manifest, {:.1}KB",
            new_subfs_uris.len(), current_file_count, manifest_size as f64 / 1024.0);
    } else {
        println!("Manifest created ({} files, {:.1}KB) - no splitting needed",
            total_files, manifest_size as f64 / 1024.0);
    }

    // Create the final Fs record
    let fs_record = Fs::new()
        .site(CowStr::from(site_name.clone()))
        .root(working_directory)
        .file_count(current_file_count as i64)
        .created_at(Datetime::now())
        .build();

    // Use site name as the record key
    let rkey = Rkey::new(&site_name).map_err(|e| miette::miette!("Invalid rkey: {}", e))?;
    let output = agent.put_record(RecordKey::from(rkey), fs_record).await?;

    // Extract DID from the AT URI (format: at://did:plc:xxx/collection/rkey)
    let uri_str = output.uri.to_string();
    let did = uri_str
        .strip_prefix("at://")
        .and_then(|s| s.split('/').next())
        .ok_or_else(|| miette::miette!("Failed to parse DID from URI"))?;

    println!("\n✓ Deployed site '{}': {}", site_name, output.uri);
    println!("  Total files: {} ({} reused, {} uploaded)", total_files, reused_count, uploaded_count);
    println!("  Available at: https://sites.wisp.place/{}/{}", did, site_name);

    // Clean up old subfs records
    if !old_subfs_uris.is_empty() {
        println!("\nCleaning up {} old subfs records...", old_subfs_uris.len());

        let mut deleted_count = 0;
        let mut failed_count = 0;

        for (uri, _path) in old_subfs_uris {
            match subfs_utils::delete_subfs_record(agent, &uri).await {
                Ok(_) => {
                    deleted_count += 1;
                    println!("  🗑️  Deleted old subfs: {}", uri);
                }
                Err(e) => {
                    failed_count += 1;
                    eprintln!("  ⚠️  Failed to delete {}: {}", uri, e);
                }
            }
        }

        if failed_count > 0 {
            eprintln!("⚠️  Cleanup completed with {} deleted, {} failed", deleted_count, failed_count);
        } else {
            println!("✅ Cleanup complete: {} old subfs records deleted", deleted_count);
        }
    }

    // Upload settings if either flag is set
    if directory_listing || spa_mode {
        // Validate mutual exclusivity
        if directory_listing && spa_mode {
            return Err(miette::miette!("Cannot enable both --directory and --SPA modes"));
        }

        println!("\n⚙️  Uploading site settings...");

        // Build settings record
        let mut settings_builder = Settings::new();

        if directory_listing {
            settings_builder = settings_builder.directory_listing(Some(true));
            println!("  • Directory listing: enabled");
        }

        if spa_mode {
            settings_builder = settings_builder.spa_mode(Some(CowStr::from("index.html")));
            println!("  • SPA mode: enabled (serving index.html for all routes)");
        }

        let settings_record = settings_builder.build();

        // Upload settings record with same rkey as site
        let rkey = Rkey::new(&site_name).map_err(|e| miette::miette!("Invalid rkey: {}", e))?;
        match agent.put_record(RecordKey::from(rkey), settings_record).await {
            Ok(settings_output) => {
                println!("✅ Settings uploaded: {}", settings_output.uri);
            }
            Err(e) => {
                eprintln!("⚠️  Failed to upload settings: {}", e);
                eprintln!("   Site was deployed successfully, but settings may need to be configured manually.");
            }
        }
    }

    Ok(())
}

/// Recursively build a Directory from a filesystem path
/// current_path is the path from the root of the site (e.g., "" for root, "config" for config dir)
fn build_directory<'a>(
    agent: &'a Agent<impl jacquard::client::AgentSession + IdentityResolver + 'a>,
    dir_path: &'a Path,
    existing_blobs: &'a HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)>,
    current_path: String,
    ignore_matcher: &'a ignore_patterns::IgnoreMatcher,
    progress: &'a ProgressBar,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = miette::Result<(Directory<'static>, usize, usize)>> + 'a>>
{
    Box::pin(async move {
    // Collect all directory entries first
    let dir_entries: Vec<_> = std::fs::read_dir(dir_path)
        .into_diagnostic()?
        .collect::<Result<Vec<_>, _>>()
        .into_diagnostic()?;

    // Separate files and directories
    let mut file_tasks = Vec::new();
    let mut dir_tasks = Vec::new();

    for entry in dir_entries {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_str()
            .ok_or_else(|| miette::miette!("Invalid filename: {:?}", name))?
            .to_string();

        // Construct full path for ignore checking
        let full_path = if current_path.is_empty() {
            name_str.clone()
        } else {
            format!("{}/{}", current_path, name_str)
        };

        // Skip files/directories that match ignore patterns
        if ignore_matcher.is_ignored(&full_path) || ignore_matcher.is_filename_ignored(&name_str) {
            continue;
        }

        let metadata = entry.metadata().into_diagnostic()?;

        if metadata.is_file() {
            // Construct full path for this file (for blob map lookup)
            let full_path = if current_path.is_empty() {
                name_str.clone()
            } else {
                format!("{}/{}", current_path, name_str)
            };
            file_tasks.push((name_str, path, full_path));
        } else if metadata.is_dir() {
            dir_tasks.push((name_str, path));
        }
    }

    // Process files concurrently with a limit of 2
    let file_results: Vec<(Entry<'static>, bool)> = stream::iter(file_tasks)
        .map(|(name, path, full_path)| async move {
            let (file_node, reused) = process_file(agent, &path, &full_path, existing_blobs, progress).await?;
            progress.inc(1);
            let entry = Entry::new()
                .name(CowStr::from(name))
                .node(EntryNode::File(Box::new(file_node)))
                .build();
            Ok::<_, miette::Report>((entry, reused))
        })
        .buffer_unordered(MAX_CONCURRENT_UPLOADS)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<miette::Result<Vec<_>>>()?;
    
    let mut file_entries = Vec::new();
    let mut reused_count = 0;
    let mut total_files = 0;
    
    for (entry, reused) in file_results {
        file_entries.push(entry);
        total_files += 1;
        if reused {
            reused_count += 1;
        }
    }

    // Process directories recursively (sequentially to avoid too much nesting)
    let mut dir_entries = Vec::new();
    for (name, path) in dir_tasks {
        // Construct full path for subdirectory
        let subdir_path = if current_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", current_path, name)
        };
        let (subdir, sub_total, sub_reused) = build_directory(agent, &path, existing_blobs, subdir_path, ignore_matcher, progress).await?;
        dir_entries.push(Entry::new()
            .name(CowStr::from(name))
            .node(EntryNode::Directory(Box::new(subdir)))
            .build());
        total_files += sub_total;
        reused_count += sub_reused;
    }

    // Combine file and directory entries
    let mut entries = file_entries;
    entries.extend(dir_entries);

    let directory = Directory::new()
        .r#type(CowStr::from("directory"))
        .entries(entries)
        .build();
    
    Ok((directory, total_files, reused_count))
    })
}

/// Process a single file: gzip -> base64 -> upload blob (or reuse existing)
/// Returns (File, reused: bool)
/// file_path_key is the full path from the site root (e.g., "config/file.json") for blob map lookup
///
/// Special handling: _redirects files are NOT compressed (uploaded as-is)
async fn process_file(
    agent: &Agent<impl jacquard::client::AgentSession + IdentityResolver>,
    file_path: &Path,
    file_path_key: &str,
    existing_blobs: &HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)>,
    progress: &ProgressBar,
) -> miette::Result<(File<'static>, bool)>
{
    // Read file
    let file_data = std::fs::read(file_path).into_diagnostic()?;

    // Detect original MIME type
    let original_mime = mime_guess::from_path(file_path)
        .first_or_octet_stream()
        .to_string();

    // Check if this is a _redirects file (don't compress it)
    let is_redirects_file = file_path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "_redirects")
        .unwrap_or(false);

    let (upload_bytes, encoding, is_base64) = if is_redirects_file {
        // Don't compress _redirects - upload as-is
        (file_data.clone(), None, false)
    } else {
        // Gzip compress
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&file_data).into_diagnostic()?;
        let gzipped = encoder.finish().into_diagnostic()?;

        // Base64 encode the gzipped data
        let base64_bytes = base64::prelude::BASE64_STANDARD.encode(&gzipped).into_bytes();
        (base64_bytes, Some("gzip"), true)
    };

    // Compute CID for this file
    let file_cid = cid::compute_cid(&upload_bytes);

    // Check if we have an existing blob with the same CID
    let existing_blob = existing_blobs.get(file_path_key);

    if let Some((existing_blob_ref, existing_cid)) = existing_blob {
        if existing_cid == &file_cid {
            // CIDs match - reuse existing blob
            progress.set_message(format!("✓ Reused {}", file_path_key));
            let mut file_builder = File::new()
                .r#type(CowStr::from("file"))
                .blob(existing_blob_ref.clone())
                .mime_type(CowStr::from(original_mime));

            if let Some(enc) = encoding {
                file_builder = file_builder.encoding(CowStr::from(enc));
            }
            if is_base64 {
                file_builder = file_builder.base64(true);
            }

            return Ok((file_builder.build(), true));
        }
    }

    // File is new or changed - upload it
    let mime_type = if is_redirects_file {
        MimeType::new_static("text/plain")
    } else {
        MimeType::new_static("application/octet-stream")
    };

    // Format file size nicely
    let size_str = if upload_bytes.len() < 1024 {
        format!("{} B", upload_bytes.len())
    } else if upload_bytes.len() < 1024 * 1024 {
        format!("{:.1} KB", upload_bytes.len() as f64 / 1024.0)
    } else {
        format!("{:.1} MB", upload_bytes.len() as f64 / (1024.0 * 1024.0))
    };

    progress.set_message(format!("↑ Uploading {} ({})", file_path_key, size_str));
    let blob = agent.upload_blob(upload_bytes, mime_type).await?;
    progress.set_message(format!("✓ Uploaded {}", file_path_key));

    let mut file_builder = File::new()
        .r#type(CowStr::from("file"))
        .blob(blob)
        .mime_type(CowStr::from(original_mime));

    if let Some(enc) = encoding {
        file_builder = file_builder.encoding(CowStr::from(enc));
    }
    if is_base64 {
        file_builder = file_builder.base64(true);
    }

    Ok((file_builder.build(), false))
}

/// Convert fs::Directory to subfs::Directory
/// They have the same structure, but different types
fn convert_fs_dir_to_subfs_dir(fs_dir: place_wisp::fs::Directory<'static>) -> place_wisp::subfs::Directory<'static> {
    use place_wisp::subfs::{Directory as SubfsDirectory, Entry as SubfsEntry, EntryNode as SubfsEntryNode, File as SubfsFile};

    let subfs_entries: Vec<SubfsEntry> = fs_dir.entries.into_iter().map(|entry| {
        let node = match entry.node {
            place_wisp::fs::EntryNode::File(file) => {
                SubfsEntryNode::File(Box::new(SubfsFile::new()
                    .r#type(file.r#type)
                    .blob(file.blob)
                    .encoding(file.encoding)
                    .mime_type(file.mime_type)
                    .base64(file.base64)
                    .build()))
            }
            place_wisp::fs::EntryNode::Directory(dir) => {
                SubfsEntryNode::Directory(Box::new(convert_fs_dir_to_subfs_dir(*dir)))
            }
            place_wisp::fs::EntryNode::Subfs(subfs) => {
                // Nested subfs in the directory we're converting
                // Note: subfs::Subfs doesn't have the 'flat' field - that's only in fs::Subfs
                SubfsEntryNode::Subfs(Box::new(place_wisp::subfs::Subfs::new()
                    .r#type(subfs.r#type)
                    .subject(subfs.subject)
                    .build()))
            }
            place_wisp::fs::EntryNode::Unknown(unknown) => {
                SubfsEntryNode::Unknown(unknown)
            }
        };

        SubfsEntry::new()
            .name(entry.name)
            .node(node)
            .build()
    }).collect();

    SubfsDirectory::new()
        .r#type(fs_dir.r#type)
        .entries(subfs_entries)
        .build()
}

