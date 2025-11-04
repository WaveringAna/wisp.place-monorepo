mod builder_types;
mod place_wisp;

use clap::Parser;
use jacquard::CowStr;
use jacquard::client::{Agent, FileAuthStore, AgentSessionExt};
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

    /// Path to auth store file (will be created if missing)
    #[arg(long, default_value = "/tmp/wisp-oauth-session.json")]
    store: String,
}

#[tokio::main]
async fn main() -> miette::Result<()> {
    let args = Args::parse();

    let oauth = OAuthClient::with_default_config(FileAuthStore::new(&args.store));
    let session = oauth
        .login_with_local_server(args.input, Default::default(), LoopbackConfig::default())
        .await?;

    let agent: Agent<_> = Agent::from(session);

    // Verify the path exists
    if !args.path.exists() {
        return Err(miette::miette!("Path does not exist: {}", args.path.display()));
    }

    // Get site name
    let site_name = args.site.unwrap_or_else(|| {
        args.path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("site")
            .to_string()
    });

    println!("Deploying site '{}'...", site_name);

    // Build directory tree
    let root_dir = build_directory(&agent, &args.path).await?;

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
    let mut entries = Vec::new();

    for entry in std::fs::read_dir(dir_path).into_diagnostic()? {
        let entry = entry.into_diagnostic()?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_str()
            .ok_or_else(|| miette::miette!("Invalid filename: {:?}", name))?;

        // Skip hidden files
        if name_str.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().into_diagnostic()?;

        if metadata.is_file() {
            let file_node = process_file(agent, &path).await?;
            entries.push(Entry::new()
                .name(CowStr::from(name_str.to_string()))
                .node(EntryNode::File(Box::new(file_node)))
                .build());
        } else if metadata.is_dir() {
            let subdir = build_directory(agent, &path).await?;
            entries.push(Entry::new()
                .name(CowStr::from(name_str.to_string()))
                .node(EntryNode::Directory(Box::new(subdir)))
                .build());
        }
    }

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
