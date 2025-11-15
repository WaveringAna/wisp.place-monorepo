use crate::blob_map;
use crate::download;
use crate::metadata::SiteMetadata;
use crate::place_wisp::fs::*;
use crate::subfs_utils;
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
    println!("Found site '{}' with {} files (in main record)", fs_record.site, file_count);

    // Check for and expand subfs nodes
    let expanded_root = expand_subfs_in_pull(&fs_record.root, &pds_url, did.as_str()).await?;
    let total_file_count = subfs_utils::count_files_in_directory(&expanded_root);

    if total_file_count as i64 != fs_record.file_count.unwrap_or(0) {
        println!("Total files after expanding subfs: {}", total_file_count);
    }

    // Load existing metadata for incremental updates
    let existing_metadata = SiteMetadata::load(&output_dir)?;
    let existing_file_cids = existing_metadata
        .as_ref()
        .map(|m| m.file_cids.clone())
        .unwrap_or_default();

    // Extract blob map from the expanded manifest
    let new_blob_map = blob_map::extract_blob_map(&expanded_root);
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

    // Check if we need to update (verify files actually exist, not just metadata)
    if let Some(metadata) = &existing_metadata {
        if metadata.record_cid == record_cid {
            // Verify that the output directory actually exists and has the expected files
            let has_all_files = output_dir.exists() && {
                // Count actual files on disk (excluding metadata)
                let mut actual_file_count = 0;
                if let Ok(entries) = std::fs::read_dir(&output_dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        if !name.to_string_lossy().starts_with(".wisp-metadata") {
                            if entry.path().is_file() {
                                actual_file_count += 1;
                            }
                        }
                    }
                }

                // Compare with expected file count from metadata
                let expected_count = metadata.file_cids.len();
                actual_file_count > 0 && actual_file_count >= expected_count
            };

            if has_all_files {
                println!("Site is already up to date!");
                return Ok(());
            } else {
                println!("Site metadata exists but files are missing, re-downloading...");
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

    // Download files recursively (using expanded root)
    let download_result = download_directory(
        &expanded_root,
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

/// Recursively download a directory with concurrent downloads
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
    use futures::stream::{self, StreamExt};

    // Collect download tasks and directory tasks separately
    struct DownloadTask {
        path: String,
        output_path: PathBuf,
        blob: jacquard_common::types::blob::BlobRef<'static>,
        base64: bool,
        gzip: bool,
    }

    struct CopyTask {
        path: String,
        from: PathBuf,
        to: PathBuf,
    }

    let mut download_tasks = Vec::new();
    let mut copy_tasks = Vec::new();
    let mut dir_tasks = Vec::new();

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
                let should_copy = if let Some((_blob_ref, new_cid)) = new_blob_map.get(&current_path) {
                    if let Some(existing_cid) = existing_file_cids.get(&current_path) {
                        if existing_cid == new_cid {
                            let existing_path = existing_output_dir.join(&current_path);
                            if existing_path.exists() {
                                copy_tasks.push(CopyTask {
                                    path: current_path.clone(),
                                    from: existing_path,
                                    to: output_path.clone(),
                                });
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                if !should_copy {
                    use jacquard_common::IntoStatic;
                    // File needs to be downloaded
                    download_tasks.push(DownloadTask {
                        path: current_path,
                        output_path,
                        blob: file.blob.clone().into_static(),
                        base64: file.base64.unwrap_or(false),
                        gzip: file.encoding.as_ref().map(|e| e.as_str() == "gzip").unwrap_or(false),
                    });
                }
            }
            EntryNode::Directory(subdir) => {
                let subdir_path = output_dir.join(entry_name);
                dir_tasks.push((subdir.as_ref().clone(), subdir_path, current_path));
            }
            EntryNode::Subfs(_) => {
                println!("  ⚠ Skipping subfs node at {} (should have been expanded)", current_path);
            }
            EntryNode::Unknown(_) => {
                println!("  ⚠ Skipping unknown node type for {}", current_path);
            }
        }
    }

    // Execute copy tasks (fast, do them all)
    for task in copy_tasks {
        std::fs::copy(&task.from, &task.to).into_diagnostic()?;
        *reused += 1;
        println!("  ✓ Reused {}", task.path);
    }

    // Execute download tasks with concurrency limit (20 concurrent downloads)
    const DOWNLOAD_CONCURRENCY: usize = 20;

    let pds_url_clone = pds_url.clone();
    let did_str = did.to_string();

    let download_results: Vec<miette::Result<(String, PathBuf, Vec<u8>)>> = stream::iter(download_tasks)
        .map(|task| {
            let pds = pds_url_clone.clone();
            let did_copy = did_str.clone();

            async move {
                println!("  ↓ Downloading {}", task.path);
                let data = download::download_and_decompress_blob(
                    &pds,
                    &task.blob,
                    &did_copy,
                    task.base64,
                    task.gzip,
                )
                .await?;

                Ok::<_, miette::Report>((task.path, task.output_path, data))
            }
        })
        .buffer_unordered(DOWNLOAD_CONCURRENCY)
        .collect()
        .await;

    // Write downloaded files to disk
    for result in download_results {
        let (path, output_path, data) = result?;
        std::fs::write(&output_path, data).into_diagnostic()?;
        *downloaded += 1;
        println!("  ✓ Downloaded {}", path);
    }

    // Recursively process directories
    for (subdir, subdir_path, current_path) in dir_tasks {
        std::fs::create_dir_all(&subdir_path).into_diagnostic()?;

        download_directory(
            &subdir,
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

    Ok(())
    })
}

/// Expand subfs nodes in a directory tree by fetching and merging subfs records (RECURSIVELY)
async fn expand_subfs_in_pull<'a>(
    directory: &Directory<'a>,
    pds_url: &Url,
    _did: &str,
) -> miette::Result<Directory<'static>> {
    use crate::place_wisp::subfs::SubfsRecord;
    use jacquard_common::types::value::from_data;
    use jacquard_common::IntoStatic;

    // Recursively fetch ALL subfs records (including nested ones)
    let mut all_subfs_map: HashMap<String, crate::place_wisp::subfs::Directory> = HashMap::new();
    let mut to_fetch = subfs_utils::extract_subfs_uris(directory, String::new());

    if to_fetch.is_empty() {
        return Ok((*directory).clone().into_static());
    }

    println!("Found {} subfs records, fetching recursively...", to_fetch.len());
    let client = reqwest::Client::new();

    // Keep fetching until we've resolved all subfs (including nested ones)
    let mut iteration = 0;
    const MAX_ITERATIONS: usize = 10; // Prevent infinite loops

    while !to_fetch.is_empty() && iteration < MAX_ITERATIONS {
        iteration += 1;
        println!("  Iteration {}: fetching {} subfs records...", iteration, to_fetch.len());

        let mut fetch_tasks = Vec::new();

        for (uri, path) in to_fetch.clone() {
            let client = client.clone();
            let pds_url = pds_url.clone();

            fetch_tasks.push(async move {
                let parts: Vec<&str> = uri.trim_start_matches("at://").split('/').collect();
                if parts.len() < 3 {
                    return Err(miette::miette!("Invalid subfs URI: {}", uri));
                }

                let _did = parts[0];
                let collection = parts[1];
                let rkey = parts[2];

                if collection != "place.wisp.subfs" {
                    return Err(miette::miette!("Expected place.wisp.subfs collection, got: {}", collection));
                }

                use jacquard::api::com_atproto::repo::get_record::GetRecord;
                use jacquard_common::types::string::Rkey as RkeyType;
                use jacquard_common::types::ident::AtIdentifier;
                use jacquard_common::types::string::{RecordKey, Did as DidType};

                let rkey_parsed = RkeyType::new(rkey).into_diagnostic()?;
                let did_parsed = DidType::new(_did).into_diagnostic()?;

                let request = GetRecord::new()
                    .repo(AtIdentifier::Did(did_parsed))
                    .collection(CowStr::from("place.wisp.subfs"))
                    .rkey(RecordKey::from(rkey_parsed))
                    .build();

                let response = client
                    .xrpc(pds_url)
                    .send(&request)
                    .await
                    .into_diagnostic()?;

                let record_output = response.into_output().into_diagnostic()?;
                let subfs_record: SubfsRecord = from_data(&record_output.value).into_diagnostic()?;
                let subfs_record_static = subfs_record.into_static();

                Ok::<_, miette::Report>((path, subfs_record_static))
            });
        }

        let results: Vec<_> = futures::future::join_all(fetch_tasks).await;

        // Process results and find nested subfs
        let mut newly_fetched = Vec::new();
        for result in results {
            match result {
                Ok((path, record)) => {
                    println!("    ✓ Fetched subfs at {}", path);

                    // Check for nested subfs in this record
                    let nested_subfs = extract_subfs_from_subfs_dir(&record.root, path.clone());
                    newly_fetched.extend(nested_subfs);

                    all_subfs_map.insert(path, record.root);
                }
                Err(e) => {
                    eprintln!("    ⚠️  Failed to fetch subfs: {}", e);
                }
            }
        }

        // Update to_fetch with only the NEW subfs we haven't fetched yet
        to_fetch = newly_fetched
            .into_iter()
            .filter(|(uri, _)| !all_subfs_map.iter().any(|(k, _)| k == uri))
            .collect();
    }

    if iteration >= MAX_ITERATIONS {
        return Err(miette::miette!("Max iterations reached while fetching nested subfs"));
    }

    println!("  Total subfs records fetched: {}", all_subfs_map.len());

    // Now replace all subfs nodes with their content
    Ok(replace_subfs_with_content(directory.clone(), &all_subfs_map, String::new()))
}

/// Extract subfs URIs from a subfs::Directory
fn extract_subfs_from_subfs_dir(
    directory: &crate::place_wisp::subfs::Directory,
    current_path: String,
) -> Vec<(String, String)> {
    let mut uris = Vec::new();

    for entry in &directory.entries {
        let full_path = if current_path.is_empty() {
            entry.name.to_string()
        } else {
            format!("{}/{}", current_path, entry.name)
        };

        match &entry.node {
            crate::place_wisp::subfs::EntryNode::Subfs(subfs_node) => {
                uris.push((subfs_node.subject.to_string(), full_path.clone()));
            }
            crate::place_wisp::subfs::EntryNode::Directory(subdir) => {
                let nested = extract_subfs_from_subfs_dir(subdir, full_path);
                uris.extend(nested);
            }
            _ => {}
        }
    }

    uris
}

/// Recursively replace subfs nodes with their actual content
fn replace_subfs_with_content(
    directory: Directory,
    subfs_map: &HashMap<String, crate::place_wisp::subfs::Directory>,
    current_path: String,
) -> Directory<'static> {
    use jacquard_common::IntoStatic;

    let new_entries: Vec<Entry<'static>> = directory
        .entries
        .into_iter()
        .flat_map(|entry| {
            let full_path = if current_path.is_empty() {
                entry.name.to_string()
            } else {
                format!("{}/{}", current_path, entry.name)
            };

            match entry.node {
                EntryNode::Subfs(subfs_node) => {
                    // Check if we have this subfs record
                    if let Some(subfs_dir) = subfs_map.get(&full_path) {
                        let flat = subfs_node.flat.unwrap_or(true); // Default to flat merge

                        if flat {
                            // Flat merge: hoist subfs entries into parent
                            println!("  Merging subfs {} (flat)", full_path);
                            let converted_entries: Vec<Entry<'static>> = subfs_dir
                                .entries
                                .iter()
                                .map(|subfs_entry| convert_subfs_entry_to_fs(subfs_entry.clone().into_static()))
                                .collect();

                            converted_entries
                        } else {
                            // Nested: create a directory with the subfs name
                            println!("  Merging subfs {} (nested)", full_path);
                            let converted_entries: Vec<Entry<'static>> = subfs_dir
                                .entries
                                .iter()
                                .map(|subfs_entry| convert_subfs_entry_to_fs(subfs_entry.clone().into_static()))
                                .collect();

                            vec![Entry::new()
                                .name(entry.name.into_static())
                                .node(EntryNode::Directory(Box::new(
                                    Directory::new()
                                        .r#type(CowStr::from("directory"))
                                        .entries(converted_entries)
                                        .build()
                                )))
                                .build()]
                        }
                    } else {
                        // Subfs not found, skip with warning
                        eprintln!("  ⚠️  Subfs not found: {}", full_path);
                        vec![]
                    }
                }
                EntryNode::Directory(dir) => {
                    // Recursively process subdirectories
                    vec![Entry::new()
                        .name(entry.name.into_static())
                        .node(EntryNode::Directory(Box::new(
                            replace_subfs_with_content(*dir, subfs_map, full_path)
                        )))
                        .build()]
                }
                EntryNode::File(_) => {
                    vec![entry.into_static()]
                }
                EntryNode::Unknown(_) => {
                    vec![entry.into_static()]
                }
            }
        })
        .collect();

    Directory::new()
        .r#type(CowStr::from("directory"))
        .entries(new_entries)
        .build()
}

/// Convert a subfs entry to a fs entry (they have the same structure but different types)
fn convert_subfs_entry_to_fs(subfs_entry: crate::place_wisp::subfs::Entry<'static>) -> Entry<'static> {
    use jacquard_common::IntoStatic;

    let node = match subfs_entry.node {
        crate::place_wisp::subfs::EntryNode::File(file) => {
            EntryNode::File(Box::new(
                File::new()
                    .r#type(file.r#type.into_static())
                    .blob(file.blob.into_static())
                    .encoding(file.encoding.map(|e| e.into_static()))
                    .mime_type(file.mime_type.map(|m| m.into_static()))
                    .base64(file.base64)
                    .build()
            ))
        }
        crate::place_wisp::subfs::EntryNode::Directory(dir) => {
            let converted_entries: Vec<Entry<'static>> = dir
                .entries
                .into_iter()
                .map(|e| convert_subfs_entry_to_fs(e.into_static()))
                .collect();

            EntryNode::Directory(Box::new(
                Directory::new()
                    .r#type(dir.r#type.into_static())
                    .entries(converted_entries)
                    .build()
            ))
        }
        crate::place_wisp::subfs::EntryNode::Subfs(_nested_subfs) => {
            // Nested subfs should have been expanded already - if we get here, it means expansion failed
            // Treat it like a directory reference that should have been expanded
            eprintln!("  ⚠️  Warning: unexpanded nested subfs at path, treating as empty directory");
            EntryNode::Directory(Box::new(
                Directory::new()
                    .r#type(CowStr::from("directory"))
                    .entries(vec![])
                    .build()
            ))
        }
        crate::place_wisp::subfs::EntryNode::Unknown(unknown) => {
            EntryNode::Unknown(unknown)
        }
    };

    Entry::new()
        .name(subfs_entry.name.into_static())
        .node(node)
        .build()
}

