mod builder_types;
mod place_wisp;

use clap::Parser;
use jacquard::CowStr;
use jacquard::client::{Agent, FileAuthStore, AgentSessionExt, MemoryCredentialSession};
use jacquard::oauth::client::OAuthClient;
use jacquard::oauth::loopback::LoopbackConfig;
use jacquard::prelude::IdentityResolver;
use jacquard_common::types::string::{Datetime, Rkey, RecordKey};
use jacquard_common::types::blob::MimeType;
use miette::IntoDiagnostic;
use std::path::{Path, PathBuf};
use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;
use base64::Engine;
use futures::stream::{self, StreamExt};

use place_wisp::fs::*;

#[derive(Parser, Debug)]
#[command(author, version, about = "Deploy a static site to wisp.place")]
struct Args {
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
}

#[tokio::main]
async fn main() -> miette::Result<()> {
    let args = Args::parse();

    // Dispatch to appropriate authentication method
    if let Some(password) = args.password {
        run_with_app_password(args.input, password, args.path, args.site).await
    } else {
        run_with_oauth(args.input, args.store, args.path, args.site).await
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

    // Build directory tree
    let root_dir = build_directory(agent, &path).await?;

    // Count total files
    let file_count = count_files(&root_dir);

    // Create the Fs record
    let fs_record = Fs::new()
        .site(CowStr::from(site_name.clone()))
        .root(root_dir)
        .file_count(file_count as i64)
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

    println!("Deployed site '{}': {}", site_name, output.uri);
    println!("Available at: https://sites.wisp.place/{}/{}", did, site_name);

    Ok(())
}

/// Recursively build a Directory from a filesystem path
fn build_directory<'a>(
    agent: &'a Agent<impl jacquard::client::AgentSession + IdentityResolver + 'a>,
    dir_path: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = miette::Result<Directory<'static>>> + 'a>>
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

        // Skip hidden files
        if name_str.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().into_diagnostic()?;

        if metadata.is_file() {
            file_tasks.push((name_str, path));
        } else if metadata.is_dir() {
            dir_tasks.push((name_str, path));
        }
    }

    // Process files concurrently with a limit of 5
    let file_entries: Vec<Entry> = stream::iter(file_tasks)
        .map(|(name, path)| async move {
            let file_node = process_file(agent, &path).await?;
            Ok::<_, miette::Report>(Entry::new()
                .name(CowStr::from(name))
                .node(EntryNode::File(Box::new(file_node)))
                .build())
        })
        .buffer_unordered(5)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<miette::Result<Vec<_>>>()?;

    // Process directories recursively (sequentially to avoid too much nesting)
    let mut dir_entries = Vec::new();
    for (name, path) in dir_tasks {
        let subdir = build_directory(agent, &path).await?;
        dir_entries.push(Entry::new()
            .name(CowStr::from(name))
            .node(EntryNode::Directory(Box::new(subdir)))
            .build());
    }

    // Combine file and directory entries
    let mut entries = file_entries;
    entries.extend(dir_entries);

    Ok(Directory::new()
        .r#type(CowStr::from("directory"))
        .entries(entries)
        .build())
    })
}

/// Process a single file: gzip -> base64 -> upload blob
async fn process_file(
    agent: &Agent<impl jacquard::client::AgentSession + IdentityResolver>,
    file_path: &Path,
) -> miette::Result<File<'static>>
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

    // Upload blob as octet-stream
    let blob = agent.upload_blob(
        base64_bytes,
        MimeType::new_static("application/octet-stream"),
    ).await?;

    Ok(File::new()
        .r#type(CowStr::from("file"))
        .blob(blob)
        .encoding(CowStr::from("gzip"))
        .mime_type(CowStr::from(original_mime))
        .base64(true)
        .build())
}

/// Count total files in a directory tree
fn count_files(dir: &Directory) -> usize {
    let mut count = 0;
    for entry in &dir.entries {
        match &entry.node {
            EntryNode::File(_) => count += 1,
            EntryNode::Directory(subdir) => count += count_files(subdir),
            _ => {} // Unknown variants
        }
    }
    count
}
