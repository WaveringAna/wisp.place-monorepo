use jacquard_common::types::string::AtUri;
use jacquard_common::types::blob::BlobRef;
use jacquard_common::IntoStatic;
use jacquard::client::{Agent, AgentSession, AgentSessionExt};
use jacquard::prelude::IdentityResolver;
use miette::IntoDiagnostic;
use std::collections::HashMap;

use crate::place_wisp::fs::{Directory as FsDirectory, EntryNode as FsEntryNode};
use crate::place_wisp::subfs::SubfsRecord;

/// Extract all subfs URIs from a directory tree with their mount paths
pub fn extract_subfs_uris(directory: &FsDirectory, current_path: String) -> Vec<(String, String)> {
    let mut uris = Vec::new();

    for entry in &directory.entries {
        let full_path = if current_path.is_empty() {
            entry.name.to_string()
        } else {
            format!("{}/{}", current_path, entry.name)
        };

        match &entry.node {
            FsEntryNode::Subfs(subfs_node) => {
                // Found a subfs node - store its URI and mount path
                uris.push((subfs_node.subject.to_string(), full_path.clone()));
            }
            FsEntryNode::Directory(subdir) => {
                // Recursively search subdirectories
                let sub_uris = extract_subfs_uris(subdir, full_path);
                uris.extend(sub_uris);
            }
            FsEntryNode::File(_) => {
                // Files don't contain subfs
            }
            FsEntryNode::Unknown(_) => {
                // Skip unknown nodes
            }
        }
    }

    uris
}

/// Fetch a subfs record from the PDS
pub async fn fetch_subfs_record(
    agent: &Agent<impl AgentSession + IdentityResolver>,
    uri: &str,
) -> miette::Result<SubfsRecord<'static>> {
    // Parse URI: at://did/collection/rkey
    let parts: Vec<&str> = uri.trim_start_matches("at://").split('/').collect();

    if parts.len() < 3 {
        return Err(miette::miette!("Invalid subfs URI: {}", uri));
    }

    let _did = parts[0];
    let collection = parts[1];
    let _rkey = parts[2];

    if collection != "place.wisp.subfs" {
        return Err(miette::miette!("Expected place.wisp.subfs collection, got: {}", collection));
    }

    // Construct AT-URI for fetching
    let at_uri = AtUri::new(uri).into_diagnostic()?;

    // Fetch the record
    let response = agent.get_record::<SubfsRecord>(&at_uri).await.into_diagnostic()?;
    let record_output = response.into_output().into_diagnostic()?;

    Ok(record_output.value.into_static())
}

/// Recursively fetch all subfs records (including nested ones)
/// Returns a list of (mount_path, SubfsRecord) tuples
/// Note: Multiple records can have the same mount_path (for flat-merged chunks)
pub async fn fetch_all_subfs_records_recursive(
    agent: &Agent<impl AgentSession + IdentityResolver>,
    initial_uris: Vec<(String, String)>,
) -> miette::Result<Vec<(String, SubfsRecord<'static>)>> {
    use futures::stream::{self, StreamExt};

    let mut all_subfs: Vec<(String, SubfsRecord<'static>)> = Vec::new();
    let mut fetched_uris: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut to_fetch = initial_uris;

    if to_fetch.is_empty() {
        return Ok(all_subfs);
    }

    println!("Found {} subfs records, fetching recursively...", to_fetch.len());

    let mut iteration = 0;
    const MAX_ITERATIONS: usize = 10;

    while !to_fetch.is_empty() && iteration < MAX_ITERATIONS {
        iteration += 1;
        println!("  Iteration {}: fetching {} subfs records...", iteration, to_fetch.len());

        let subfs_results: Vec<_> = stream::iter(to_fetch.clone())
            .map(|(uri, mount_path)| async move {
                match fetch_subfs_record(agent, &uri).await {
                    Ok(record) => Some((mount_path, record, uri)),
                    Err(e) => {
                        eprintln!("  ⚠️  Failed to fetch subfs {}: {}", uri, e);
                        None
                    }
                }
            })
            .buffer_unordered(5)
            .collect()
            .await;

        // Process results and find nested subfs
        let mut newly_found_uris = Vec::new();
        for result in subfs_results {
            if let Some((mount_path, record, uri)) = result {
                println!("    ✓ Fetched subfs at {}", mount_path);

                // Extract nested subfs URIs from this record
                let nested_uris = extract_subfs_uris_from_subfs_dir(&record.root, mount_path.clone());
                newly_found_uris.extend(nested_uris);

                all_subfs.push((mount_path, record));
                fetched_uris.insert(uri);
            }
        }

        // Filter out already-fetched URIs (based on URI, not path)
        to_fetch = newly_found_uris
            .into_iter()
            .filter(|(uri, _)| !fetched_uris.contains(uri))
            .collect();
    }

    if iteration >= MAX_ITERATIONS {
        eprintln!("⚠️  Max iterations reached while fetching nested subfs");
    }

    println!("  Total subfs records fetched: {}", all_subfs.len());

    Ok(all_subfs)
}

/// Extract subfs URIs from a subfs::Directory
fn extract_subfs_uris_from_subfs_dir(
    directory: &crate::place_wisp::subfs::Directory,
    current_path: String,
) -> Vec<(String, String)> {
    let mut uris = Vec::new();

    for entry in &directory.entries {
        match &entry.node {
            crate::place_wisp::subfs::EntryNode::Subfs(subfs_node) => {
                // Check if this is a chunk entry (chunk0, chunk1, etc.)
                // Chunks should be flat-merged, so use the parent's path
                let mount_path = if entry.name.starts_with("chunk") &&
                                   entry.name.chars().skip(5).all(|c| c.is_ascii_digit()) {
                    // This is a chunk - use parent's path for flat merge
                    println!("  → Found chunk {} at {}, will flat-merge to {}", entry.name, current_path, current_path);
                    current_path.clone()
                } else {
                    // Normal subfs - append name to path
                    if current_path.is_empty() {
                        entry.name.to_string()
                    } else {
                        format!("{}/{}", current_path, entry.name)
                    }
                };

                uris.push((subfs_node.subject.to_string(), mount_path));
            }
            crate::place_wisp::subfs::EntryNode::Directory(subdir) => {
                let full_path = if current_path.is_empty() {
                    entry.name.to_string()
                } else {
                    format!("{}/{}", current_path, entry.name)
                };
                let nested = extract_subfs_uris_from_subfs_dir(subdir, full_path);
                uris.extend(nested);
            }
            _ => {}
        }
    }

    uris
}

/// Merge blob maps from subfs records into the main blob map (RECURSIVE)
/// Returns the total number of blobs merged from all subfs records
pub async fn merge_subfs_blob_maps(
    agent: &Agent<impl AgentSession + IdentityResolver>,
    subfs_uris: Vec<(String, String)>,
    main_blob_map: &mut HashMap<String, (BlobRef<'static>, String)>,
) -> miette::Result<usize> {
    // Fetch all subfs records recursively
    let all_subfs = fetch_all_subfs_records_recursive(agent, subfs_uris).await?;

    let mut total_merged = 0;

    // Extract blobs from all fetched subfs records
    // Skip parent records that only contain chunk references (no actual files)
    for (mount_path, subfs_record) in all_subfs {
        // Check if this record only contains chunk subfs references (no files)
        let only_has_chunks = subfs_record.root.entries.iter().all(|e| {
            matches!(&e.node, crate::place_wisp::subfs::EntryNode::Subfs(_)) &&
            e.name.starts_with("chunk") &&
            e.name.chars().skip(5).all(|c| c.is_ascii_digit())
        });

        if only_has_chunks && !subfs_record.root.entries.is_empty() {
            // This is a parent containing only chunks - skip it, blobs are in the chunks
            println!("  → Skipping parent subfs at {} ({} chunks, no files)", mount_path, subfs_record.root.entries.len());
            continue;
        }

        let subfs_blob_map = extract_subfs_blobs(&subfs_record.root, mount_path.clone());
        let count = subfs_blob_map.len();

        for (path, blob_info) in subfs_blob_map {
            main_blob_map.insert(path, blob_info);
        }

        total_merged += count;
        println!("  ✓ Merged {} blobs from subfs at {}", count, mount_path);
    }

    Ok(total_merged)
}

/// Extract blobs from a subfs directory (works with subfs::Directory)
/// Returns a map of file paths to their blob refs and CIDs
fn extract_subfs_blobs(
    directory: &crate::place_wisp::subfs::Directory,
    current_path: String,
) -> HashMap<String, (BlobRef<'static>, String)> {
    let mut blob_map = HashMap::new();

    for entry in &directory.entries {
        let full_path = if current_path.is_empty() {
            entry.name.to_string()
        } else {
            format!("{}/{}", current_path, entry.name)
        };

        match &entry.node {
            crate::place_wisp::subfs::EntryNode::File(file_node) => {
                let blob_ref = &file_node.blob;
                let cid_string = blob_ref.blob().r#ref.to_string();
                blob_map.insert(
                    full_path,
                    (blob_ref.clone().into_static(), cid_string)
                );
            }
            crate::place_wisp::subfs::EntryNode::Directory(subdir) => {
                let sub_map = extract_subfs_blobs(subdir, full_path);
                blob_map.extend(sub_map);
            }
            crate::place_wisp::subfs::EntryNode::Subfs(_nested_subfs) => {
                // Nested subfs - these should be resolved recursively in the main flow
                // For now, we skip them (they'll be fetched separately)
                eprintln!("  ⚠️  Found nested subfs at {}, skipping (should be fetched separately)", full_path);
            }
            crate::place_wisp::subfs::EntryNode::Unknown(_) => {
                // Skip unknown nodes
            }
        }
    }

    blob_map
}

/// Count total files in a directory tree
pub fn count_files_in_directory(directory: &FsDirectory) -> usize {
    let mut count = 0;

    for entry in &directory.entries {
        match &entry.node {
            FsEntryNode::File(_) => count += 1,
            FsEntryNode::Directory(subdir) => {
                count += count_files_in_directory(subdir);
            }
            FsEntryNode::Subfs(_) => {
                // Subfs nodes don't count towards the main manifest file count
            }
            FsEntryNode::Unknown(_) => {}
        }
    }

    count
}

/// Estimate JSON size of a directory tree
pub fn estimate_directory_size(directory: &FsDirectory) -> usize {
    // Serialize to JSON and measure
    match serde_json::to_string(directory) {
        Ok(json) => json.len(),
        Err(_) => 0,
    }
}

/// Information about a directory that could be split into a subfs record
#[derive(Debug)]
pub struct SplittableDirectory {
    pub path: String,
    pub directory: FsDirectory<'static>,
    pub size: usize,
    pub file_count: usize,
}

/// Find large directories that could be split into subfs records
/// Returns directories sorted by size (largest first)
pub fn find_large_directories(directory: &FsDirectory, current_path: String) -> Vec<SplittableDirectory> {
    let mut result = Vec::new();

    for entry in &directory.entries {
        if let FsEntryNode::Directory(subdir) = &entry.node {
            let dir_path = if current_path.is_empty() {
                entry.name.to_string()
            } else {
                format!("{}/{}", current_path, entry.name)
            };

            let size = estimate_directory_size(subdir);
            let file_count = count_files_in_directory(subdir);

            result.push(SplittableDirectory {
                path: dir_path.clone(),
                directory: (*subdir.clone()).into_static(),
                size,
                file_count,
            });

            // Recursively find subdirectories
            let subdirs = find_large_directories(subdir, dir_path);
            result.extend(subdirs);
        }
    }

    // Sort by size (largest first)
    result.sort_by(|a, b| b.size.cmp(&a.size));

    result
}

/// Replace a directory with a subfs node in the tree
pub fn replace_directory_with_subfs(
    directory: FsDirectory<'static>,
    target_path: &str,
    subfs_uri: &str,
    flat: bool,
) -> miette::Result<FsDirectory<'static>> {
    use jacquard_common::CowStr;
    use crate::place_wisp::fs::{Entry, Subfs};

    let path_parts: Vec<&str> = target_path.split('/').collect();

    if path_parts.is_empty() {
        return Err(miette::miette!("Cannot replace root directory"));
    }

    // Parse the subfs URI and make it owned/'static
    let at_uri = AtUri::new_cow(jacquard_common::CowStr::from(subfs_uri.to_string())).into_diagnostic()?;

    // If this is a root-level directory
    if path_parts.len() == 1 {
        let target_name = path_parts[0];
        let new_entries: Vec<Entry> = directory.entries.into_iter().map(|entry| {
            if entry.name == target_name {
                // Replace this directory with a subfs node
                Entry::new()
                    .name(entry.name)
                    .node(FsEntryNode::Subfs(Box::new(
                        Subfs::new()
                            .r#type(CowStr::from("subfs"))
                            .subject(at_uri.clone())
                            .flat(Some(flat))
                            .build()
                    )))
                    .build()
            } else {
                entry
            }
        }).collect();

        return Ok(FsDirectory::new()
            .r#type(CowStr::from("directory"))
            .entries(new_entries)
            .build());
    }

    // Recursively navigate to parent directory
    let first_part = path_parts[0];
    let remaining_path = path_parts[1..].join("/");

    let new_entries: Vec<Entry> = directory.entries.into_iter().filter_map(|entry| {
        if entry.name == first_part {
            if let FsEntryNode::Directory(subdir) = entry.node {
                // Recursively process this subdirectory
                match replace_directory_with_subfs((*subdir).into_static(), &remaining_path, subfs_uri, flat) {
                    Ok(updated_subdir) => {
                        Some(Entry::new()
                            .name(entry.name)
                            .node(FsEntryNode::Directory(Box::new(updated_subdir)))
                            .build())
                    }
                    Err(_) => None, // Skip entries that fail to update
                }
            } else {
                Some(entry)
            }
        } else {
            Some(entry)
        }
    }).collect();

    Ok(FsDirectory::new()
        .r#type(CowStr::from("directory"))
        .entries(new_entries)
        .build())
}

/// Delete a subfs record from the PDS
pub async fn delete_subfs_record(
    agent: &Agent<impl AgentSession + IdentityResolver>,
    uri: &str,
) -> miette::Result<()> {
    use jacquard_common::types::uri::RecordUri;

    // Construct AT-URI and convert to RecordUri
    let at_uri = AtUri::new(uri).into_diagnostic()?;
    let record_uri: RecordUri<'_, crate::place_wisp::subfs::SubfsRecordRecord> = RecordUri::try_from_uri(at_uri).into_diagnostic()?;

    let rkey = record_uri.rkey()
        .ok_or_else(|| miette::miette!("Invalid subfs URI: missing rkey"))?
        .clone();

    agent.delete_record::<SubfsRecord>(rkey).await.into_diagnostic()?;

    Ok(())
}

/// Split a large directory into multiple smaller chunks
/// Returns a list of chunk directories, each small enough to fit in a subfs record
pub fn split_directory_into_chunks(
    directory: &FsDirectory,
    max_size: usize,
) -> Vec<FsDirectory<'static>> {
    use jacquard_common::CowStr;

    let mut chunks = Vec::new();
    let mut current_chunk_entries = Vec::new();
    let mut current_chunk_size = 100; // Base size for directory structure

    for entry in &directory.entries {
        // Estimate the size of this entry
        let entry_size = estimate_entry_size(entry);

        // If adding this entry would exceed the max size, start a new chunk
        if !current_chunk_entries.is_empty() && (current_chunk_size + entry_size > max_size) {
            // Create a chunk from current entries
            let chunk = FsDirectory::new()
                .r#type(CowStr::from("directory"))
                .entries(current_chunk_entries.clone())
                .build();

            chunks.push(chunk);

            // Start new chunk
            current_chunk_entries.clear();
            current_chunk_size = 100;
        }

        current_chunk_entries.push(entry.clone().into_static());
        current_chunk_size += entry_size;
    }

    // Add the last chunk if it has any entries
    if !current_chunk_entries.is_empty() {
        let chunk = FsDirectory::new()
            .r#type(CowStr::from("directory"))
            .entries(current_chunk_entries)
            .build();
        chunks.push(chunk);
    }

    chunks
}

/// Estimate the JSON size of a single entry
fn estimate_entry_size(entry: &crate::place_wisp::fs::Entry) -> usize {
    match serde_json::to_string(entry) {
        Ok(json) => json.len(),
        Err(_) => 500, // Conservative estimate if serialization fails
    }
}
