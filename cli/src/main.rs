mod builder_types;
mod place_wisp;
mod cid;
mod blob_map;
mod metadata;
mod download;
mod pull;
mod serve;
mod subfs_utils;

use clap::{Parser, Subcommand};
use jacquard::CowStr;
use jacquard::client::{Agent, FileAuthStore, AgentSessionExt, MemoryCredentialSession, AgentSession};
use jacquard::oauth::client::OAuthClient;
use jacquard::oauth::loopback::LoopbackConfig;
use jacquard::prelude::IdentityResolver;
use jacquard_common::types::string::{Datetime, Rkey, RecordKey};
use jacquard_common::types::blob::MimeType;
use miette::IntoDiagnostic;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;
use base64::Engine;
use futures::stream::{self, StreamExt};

use place_wisp::fs::*;

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

    match args.command {
        Some(Commands::Deploy { input, path, site, store, password }) => {
            // Dispatch to appropriate authentication method
            if let Some(password) = password {
                run_with_app_password(input, password, path, site).await
            } else {
                run_with_oauth(input, store, path, site).await
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
                    run_with_app_password(input, password, path, args.site).await
                } else {
                    run_with_oauth(input, store, path, args.site).await
                }
            } else {
                // No command and no input, show help
                use clap::CommandFactory;
                Args::command().print_help().into_diagnostic()?;
                Ok(())
            }
        }
    }
}

/// Run deployment with app password authentication
async fn run_with_app_password(
    input: CowStr<'static>,
    password: CowStr<'static>,
    path: PathBuf,
    site: Option<String>,
) -> miette::Result<()> {
    let (session, auth) =
        MemoryCredentialSession::authenticated(input, password, None).await?;
    println!("Signed in as {}", auth.handle);

    let agent: Agent<_> = Agent::from(session);
    deploy_site(&agent, path, site).await
}

/// Run deployment with OAuth authentication
async fn run_with_oauth(
    input: CowStr<'static>,
    store: String,
    path: PathBuf,
    site: Option<String>,
) -> miette::Result<()> {
    let oauth = OAuthClient::with_default_config(FileAuthStore::new(&store));
    let session = oauth
        .login_with_local_server(input, Default::default(), LoopbackConfig::default())
        .await?;

    let agent: Agent<_> = Agent::from(session);
    deploy_site(&agent, path, site).await
}

/// Deploy the site using the provided agent
async fn deploy_site(
    agent: &Agent<impl jacquard::client::AgentSession + IdentityResolver>,
    path: PathBuf,
    site: Option<String>,
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

    // Build directory tree
    let (root_dir, total_files, reused_count) = build_directory(agent, &path, &existing_blob_map, String::new()).await?;
    let uploaded_count = total_files - reused_count;

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

                // Create a subfs record for this directory
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

                let subfs_uri = subfs_output.uri.to_string();
                println!("  ✅ Created subfs: {}", subfs_uri);

                // Replace directory with subfs node (flat: false to preserve structure)
                working_directory = subfs_utils::replace_directory_with_subfs(
                    working_directory,
                    &largest_dir.path,
                    &subfs_uri,
                    false // Preserve directory structure
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

    Ok(())
}

/// Recursively build a Directory from a filesystem path
/// current_path is the path from the root of the site (e.g., "" for root, "config" for config dir)
fn build_directory<'a>(
    agent: &'a Agent<impl jacquard::client::AgentSession + IdentityResolver + 'a>,
    dir_path: &'a Path,
    existing_blobs: &'a HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)>,
    current_path: String,
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

        // Skip .git directories
        if name_str == ".git" {
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

    // Process files concurrently with a limit of 5
    let file_results: Vec<(Entry<'static>, bool)> = stream::iter(file_tasks)
        .map(|(name, path, full_path)| async move {
            let (file_node, reused) = process_file(agent, &path, &full_path, existing_blobs).await?;
            let entry = Entry::new()
                .name(CowStr::from(name))
                .node(EntryNode::File(Box::new(file_node)))
                .build();
            Ok::<_, miette::Report>((entry, reused))
        })
        .buffer_unordered(5)
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
        let (subdir, sub_total, sub_reused) = build_directory(agent, &path, existing_blobs, subdir_path).await?;
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
async fn process_file(
    agent: &Agent<impl jacquard::client::AgentSession + IdentityResolver>,
    file_path: &Path,
    file_path_key: &str,
    existing_blobs: &HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)>,
) -> miette::Result<(File<'static>, bool)>
{
    // Read file
    let file_data = std::fs::read(file_path).into_diagnostic()?;

    // Detect original MIME type
    let original_mime = mime_guess::from_path(file_path)
        .first_or_octet_stream()
        .to_string();

    // Gzip compress
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&file_data).into_diagnostic()?;
    let gzipped = encoder.finish().into_diagnostic()?;

    // Base64 encode the gzipped data
    let base64_bytes = base64::prelude::BASE64_STANDARD.encode(&gzipped).into_bytes();

    // Compute CID for this file (CRITICAL: on base64-encoded gzipped content)
    let file_cid = cid::compute_cid(&base64_bytes);
    
    // Check if we have an existing blob with the same CID
    let existing_blob = existing_blobs.get(file_path_key);
    
    if let Some((existing_blob_ref, existing_cid)) = existing_blob {
        if existing_cid == &file_cid {
            // CIDs match - reuse existing blob
            println!("  ✓ Reusing blob for {} (CID: {})", file_path_key, file_cid);
            return Ok((
                File::new()
                    .r#type(CowStr::from("file"))
                    .blob(existing_blob_ref.clone())
                    .encoding(CowStr::from("gzip"))
                    .mime_type(CowStr::from(original_mime))
                    .base64(true)
                    .build(),
                true
            ));
        }
    }
    
    // File is new or changed - upload it
    println!("  ↑ Uploading {} ({} bytes, CID: {})", file_path_key, base64_bytes.len(), file_cid);
    let blob = agent.upload_blob(
        base64_bytes,
        MimeType::new_static("application/octet-stream"),
    ).await?;

    Ok((
        File::new()
            .r#type(CowStr::from("file"))
            .blob(blob)
            .encoding(CowStr::from("gzip"))
            .mime_type(CowStr::from(original_mime))
            .base64(true)
            .build(),
        false
    ))
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

