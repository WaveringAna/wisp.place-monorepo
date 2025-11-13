use crate::blob_map;
use crate::download;
use crate::metadata::SiteMetadata;
use crate::place_wisp::fs::*;
use jacquard::CowStr;
use jacquard::prelude::IdentityResolver;
use jacquard_common::types::string::Did;
use jacquard_common::xrpc::XrpcExt;
use jacquard_identity::PublicResolver;
use miette::IntoDiagnostic;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use url::Url;

/// Pull a site from the PDS to a local directory
pub async fn pull_site(
    input: CowStr<'static>,
    rkey: CowStr<'static>,
    output_dir: PathBuf,
) -> miette::Result<()> {
    println!("Pulling site {} from {}...", rkey, input);

    // Resolve handle to DID if needed
    let resolver = PublicResolver::default();
    let did = if input.starts_with("did:") {
        Did::new(&input).into_diagnostic()?
    } else {
        // It's a handle, resolve it
        let handle = jacquard_common::types::string::Handle::new(&input).into_diagnostic()?;
        resolver.resolve_handle(&handle).await.into_diagnostic()?
    };

    // Resolve PDS endpoint for the DID
    let pds_url = resolver.pds_for_did(&did).await.into_diagnostic()?;
    println!("Resolved PDS: {}", pds_url);

    // Fetch the place.wisp.fs record

    println!("Fetching record from PDS...");
    let client = reqwest::Client::new();
    
    // Use com.atproto.repo.getRecord
    use jacquard::api::com_atproto::repo::get_record::GetRecord;
    use jacquard_common::types::string::Rkey as RkeyType;
    let rkey_parsed = RkeyType::new(&rkey).into_diagnostic()?;
    
    use jacquard_common::types::ident::AtIdentifier;
    use jacquard_common::types::string::RecordKey;
    let request = GetRecord::new()
        .repo(AtIdentifier::Did(did.clone()))
        .collection(CowStr::from("place.wisp.fs"))
        .rkey(RecordKey::from(rkey_parsed))
        .build();

    let response = client
        .xrpc(pds_url.clone())
        .send(&request)
        .await
        .into_diagnostic()?;

    let record_output = response.into_output().into_diagnostic()?;
    let record_cid = record_output.cid.as_ref().map(|c| c.to_string()).unwrap_or_default();

    // Parse the record value as Fs
    use jacquard_common::types::value::from_data;
    let fs_record: Fs = from_data(&record_output.value).into_diagnostic()?;

    let file_count = fs_record.file_count.map(|c| c.to_string()).unwrap_or_else(|| "?".to_string());
    println!("Found site '{}' with {} files", fs_record.site, file_count);

    // Load existing metadata for incremental updates
    let existing_metadata = SiteMetadata::load(&output_dir)?;
    let existing_file_cids = existing_metadata
        .as_ref()
        .map(|m| m.file_cids.clone())
        .unwrap_or_default();

    // Extract blob map from the new manifest
    let new_blob_map = blob_map::extract_blob_map(&fs_record.root);
    let new_file_cids: HashMap<String, String> = new_blob_map
        .iter()
        .map(|(path, (_blob_ref, cid))| (path.clone(), cid.clone()))
        .collect();

    // Clean up any leftover temp directories from previous failed attempts
    let parent = output_dir.parent().unwrap_or_else(|| std::path::Path::new("."));
    let output_name = output_dir.file_name().unwrap_or_else(|| std::ffi::OsStr::new("site")).to_string_lossy();
    let temp_prefix = format!(".tmp-{}-", output_name);
    
    if let Ok(entries) = parent.read_dir() {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(&temp_prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    // Check if we need to update (but only if output directory actually exists with files)
    if let Some(metadata) = &existing_metadata {
        if metadata.record_cid == record_cid {
            // Verify that the output directory actually exists and has content
            let has_content = output_dir.exists() && 
                output_dir.read_dir()
                    .map(|mut entries| entries.any(|e| {
                        if let Ok(entry) = e {
                            !entry.file_name().to_string_lossy().starts_with(".wisp-metadata")
                        } else {
                            false
                        }
                    }))
                    .unwrap_or(false);
            
            if has_content {
                println!("Site is already up to date!");
                return Ok(());
            }
        }
    }

    // Create temporary directory for atomic update
    // Place temp dir in parent directory to avoid issues with non-existent output_dir
    let parent = output_dir.parent().unwrap_or_else(|| std::path::Path::new("."));
    let temp_dir_name = format!(
        ".tmp-{}-{}",
        output_dir.file_name().unwrap_or_else(|| std::ffi::OsStr::new("site")).to_string_lossy(),
        chrono::Utc::now().timestamp()
    );
    let temp_dir = parent.join(temp_dir_name);
    std::fs::create_dir_all(&temp_dir).into_diagnostic()?;

    println!("Downloading files...");
    let mut downloaded = 0;
    let mut reused = 0;

    // Download files recursively
    let download_result = download_directory(
        &fs_record.root,
        &temp_dir,
        &pds_url,
        did.as_str(),
        &new_blob_map,
        &existing_file_cids,
        &output_dir,
        String::new(),
        &mut downloaded,
        &mut reused,
    )
    .await;

    // If download failed, clean up temp directory
    if let Err(e) = download_result {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    println!(
        "Downloaded {} files, reused {} files",
        downloaded, reused
    );

    // Save metadata
    let metadata = SiteMetadata::new(record_cid, new_file_cids);
    metadata.save(&temp_dir)?;

    // Move files from temp to output directory
    let output_abs = std::fs::canonicalize(&output_dir).unwrap_or_else(|_| output_dir.clone());
    let current_dir = std::env::current_dir().into_diagnostic()?;
    
    // Special handling for pulling to current directory
    if output_abs == current_dir {
        // Move files from temp to current directory
        for entry in std::fs::read_dir(&temp_dir).into_diagnostic()? {
            let entry = entry.into_diagnostic()?;
            let dest = current_dir.join(entry.file_name());
            
            // Remove existing file/dir if it exists
            if dest.exists() {
                if dest.is_dir() {
                    std::fs::remove_dir_all(&dest).into_diagnostic()?;
                } else {
                    std::fs::remove_file(&dest).into_diagnostic()?;
                }
            }
            
            // Move from temp to current dir
            std::fs::rename(entry.path(), dest).into_diagnostic()?;
        }
        
        // Clean up temp directory
        std::fs::remove_dir_all(&temp_dir).into_diagnostic()?;
    } else {
        // If output directory exists and has content, remove it first
        if output_dir.exists() {
            std::fs::remove_dir_all(&output_dir).into_diagnostic()?;
        }
        
        // Ensure parent directory exists
        if let Some(parent) = output_dir.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent).into_diagnostic()?;
            }
        }
        
        // Rename temp to final location
        match std::fs::rename(&temp_dir, &output_dir) {
            Ok(_) => {},
            Err(e) => {
                // Clean up temp directory on failure
                let _ = std::fs::remove_dir_all(&temp_dir);
                return Err(miette::miette!("Failed to move temp directory: {}", e));
            }
        }
    }

    println!("✓ Site pulled successfully to {}", output_dir.display());

    Ok(())
}

/// Recursively download a directory
fn download_directory<'a>(
    dir: &'a Directory<'_>,
    output_dir: &'a Path,
    pds_url: &'a Url,
    did: &'a str,
    new_blob_map: &'a HashMap<String, (jacquard_common::types::blob::BlobRef<'static>, String)>,
    existing_file_cids: &'a HashMap<String, String>,
    existing_output_dir: &'a Path,
    path_prefix: String,
    downloaded: &'a mut usize,
    reused: &'a mut usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = miette::Result<()>> + Send + 'a>> {
    Box::pin(async move {
    for entry in &dir.entries {
        let entry_name = entry.name.as_str();
        let current_path = if path_prefix.is_empty() {
            entry_name.to_string()
        } else {
            format!("{}/{}", path_prefix, entry_name)
        };

        match &entry.node {
            EntryNode::File(file) => {
                let output_path = output_dir.join(entry_name);

                // Check if file CID matches existing
                if let Some((_blob_ref, new_cid)) = new_blob_map.get(&current_path) {
                    if let Some(existing_cid) = existing_file_cids.get(&current_path) {
                        if existing_cid == new_cid {
                            // File unchanged, copy from existing directory
                            let existing_path = existing_output_dir.join(&current_path);
                            if existing_path.exists() {
                                std::fs::copy(&existing_path, &output_path).into_diagnostic()?;
                                *reused += 1;
                                println!("  ✓ Reused {}", current_path);
                                continue;
                            }
                        }
                    }
                }

                // File is new or changed, download it
                println!("  ↓ Downloading {}", current_path);
                let data = download::download_and_decompress_blob(
                    pds_url,
                    &file.blob,
                    did,
                    file.base64.unwrap_or(false),
                    file.encoding.as_ref().map(|e| e.as_str() == "gzip").unwrap_or(false),
                )
                .await?;

                std::fs::write(&output_path, data).into_diagnostic()?;
                *downloaded += 1;
            }
            EntryNode::Directory(subdir) => {
                let subdir_path = output_dir.join(entry_name);
                std::fs::create_dir_all(&subdir_path).into_diagnostic()?;

                download_directory(
                    subdir,
                    &subdir_path,
                    pds_url,
                    did,
                    new_blob_map,
                    existing_file_cids,
                    existing_output_dir,
                    current_path,
                    downloaded,
                    reused,
                )
                .await?;
            }
            EntryNode::Unknown(_) => {
                // Skip unknown node types
                println!("  ⚠ Skipping unknown node type for {}", current_path);
            }
        }
    }

    Ok(())
    })
}

