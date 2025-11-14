mod builder_types;
mod place_wisp;
mod cid;
mod blob_map;
mod metadata;
mod download;
mod pull;
mod serve;

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
    let existing_blob_map: HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)> = {
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
                                let blob_map = blob_map::extract_blob_map(&existing_manifest.root);
                                println!("Found existing manifest with {} files, checking for changes...", blob_map.len());
                                blob_map
                            }
                            Err(_) => {
                                println!("No existing manifest found, uploading all files...");
                                HashMap::new()
                            }
                        }
                    }
                    Err(_) => {
                        // Record doesn't exist yet - this is a new site
                        println!("No existing manifest found, uploading all files...");
                        HashMap::new()
                    }
                }
            } else {
                println!("No existing manifest found (invalid URI), uploading all files...");
                HashMap::new()
            }
        } else {
            println!("No existing manifest found (could not get DID), uploading all files...");
            HashMap::new()
        }
    };

    // Build directory tree
    let (root_dir, total_files, reused_count) = build_directory(agent, &path, &existing_blob_map, String::new()).await?;
    let uploaded_count = total_files - reused_count;

    // Create the Fs record
    let fs_record = Fs::new()
        .site(CowStr::from(site_name.clone()))
        .root(root_dir)
        .file_count(total_files as i64)
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

