//! Pure subfs write planning, using the TypeScript CLI's thresholds and keys.
use crate::convert::fs_to_subfs;
use crate::tree::{count_files, directory, root_type};
use jacquard_common::types::string::{AtUri, Datetime};
use wisp_lexicons::place_wisp::{
    fs::{Directory, Entry, EntryNode, Fs, Subfs},
    subfs::{self, SubfsRecord},
};

pub const MAX_MANIFEST_SIZE: usize = 140 * 1024;
pub const FILE_COUNT_THRESHOLD: usize = 250;
pub const TARGET_FILE_COUNT: usize = 200;
pub const MAX_SUBFS_SIZE: usize = 75 * 1024;

#[derive(Debug, Clone)]
pub struct SubfsWrite {
    pub rkey: String,
    pub root: subfs::Directory,
    pub file_count: usize,
}
#[derive(Debug, Clone)]
pub struct SplitPlan {
    pub directory: Directory,
    pub records: Vec<SubfsWrite>,
    pub messages: Vec<SplitMessage>,
}

#[derive(Debug, Clone)]
pub enum SplitMessage {
    DirectoryTooLarge {
        size: usize,
    },
    CreatedChunks {
        count: usize,
    },
    UploadingChunk {
        index: usize,
        count: usize,
        files: usize,
        size: usize,
    },
    CreatingParent {
        count: usize,
    },
    CreatedParent {
        count: usize,
    },
    CannotSplit {
        files: usize,
        size: usize,
    },
}

#[derive(Debug)]
pub enum SplitError {
    InvalidUri(String),
}
impl std::fmt::Display for SplitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUri(uri) => write!(f, "Invalid subfs URI: {uri}"),
        }
    }
}
impl std::error::Error for SplitError {}

pub fn manifest(site: &str, root: &Directory, created_at: &Datetime) -> Fs {
    Fs {
        created_at: created_at.clone(),
        file_count: Some(count_files(root) as i64),
        root: Directory {
            extra_data: root_type("place.wisp.fs#directory"),
            ..root.clone()
        },
        site: site.into(),
        extra_data: None,
    }
}

/// The `place.wisp.subfs` record for one planned write.
pub fn subfs_record(write: &SubfsWrite, created_at: &Datetime) -> SubfsRecord {
    SubfsRecord {
        created_at: created_at.clone(),
        file_count: Some(write.file_count as i64),
        root: subfs::Directory {
            extra_data: root_type("place.wisp.subfs#directory"),
            ..write.root.clone()
        },
        extra_data: None,
    }
}

// JS counts UTF-16 code units, not UTF-8 bytes, in JSON.stringify(...).length.
fn json_size(value: &impl serde::Serialize) -> usize {
    serde_json::to_string(&serde_json::to_value(value).expect("lexicon serialization"))
        .expect("JSON serialization")
        .encode_utf16()
        .count()
}

/// Size of a directory as the TypeScript CLI measures it: its directory
/// objects always carry `"$type":"place.wisp.fs#directory",`, which ours only
/// get from a union tag or as a record root.
fn directory_size(dir: &Directory) -> usize {
    json_size(dir) + r#""$type":"place.wisp.fs#directory","#.len()
}

/// Plan the subfs records that bring `root` under the manifest limits.
///
/// `generation` (unique per deploy, e.g. a TID) is part of every new record
/// key. Reusing the previous deploy's keys would overwrite records that still
/// reference reused blobs, and the PDS deletes a blob as soon as nothing
/// references it, so a later write in the same deploy then fails with
/// `BlobNotFound`. With fresh keys the old records stay until deploy removes
/// them after the new manifest is in place.
pub fn split_plan(
    root: &Directory,
    did: &str,
    site: &str,
    generation: &str,
    created_at: &Datetime,
) -> Result<SplitPlan, SplitError> {
    let mut plan = SplitPlan {
        directory: root.clone(),
        records: Vec::new(),
        messages: Vec::new(),
    };
    if count_files(root) < FILE_COUNT_THRESHOLD
        && json_size(&manifest(site, root, created_at)) <= MAX_MANIFEST_SIZE
    {
        return Ok(plan);
    }
    let mut chunk_counter = 0;
    for iteration in 1..=100 {
        if count_files(&plan.directory) <= TARGET_FILE_COUNT
            && json_size(&manifest(site, &plan.directory, created_at)) <= MAX_MANIFEST_SIZE
        {
            break;
        }
        let mut dirs = large_directories(&plan.directory, "");
        dirs.sort_by_key(|(_, dir)| std::cmp::Reverse(directory_size(dir)));
        if let Some((path, largest)) = dirs.into_iter().next().map(splittable) {
            let largest = &largest;
            let rkey = format!("{site}-{generation}-subfs-{iteration}");
            let uri = if directory_size(largest) > MAX_SUBFS_SIZE {
                let chunks = split_chunks(largest, MAX_SUBFS_SIZE);
                plan.messages.push(SplitMessage::DirectoryTooLarge {
                    size: directory_size(largest),
                });
                plan.messages.push(SplitMessage::CreatedChunks {
                    count: chunks.len(),
                });
                let mut entries = Vec::new();
                for (index, chunk) in chunks.iter().enumerate() {
                    plan.messages.push(SplitMessage::UploadingChunk {
                        index: index + 1,
                        count: chunks.len(),
                        files: count_files(chunk),
                        size: directory_size(chunk),
                    });
                    let key = format!("{site}-{generation}-chunk-{chunk_counter}");
                    chunk_counter += 1;
                    let uri = add_record(&mut plan, did, key, chunk);
                    entries.push(reference(&format!("chunk{index}"), &uri, true)?);
                }
                plan.messages.push(SplitMessage::CreatingParent {
                    count: chunks.len(),
                });
                let uri = add_record(&mut plan, did, rkey, &directory(entries));
                plan.messages.push(SplitMessage::CreatedParent {
                    count: chunks.len(),
                });
                uri
            } else {
                add_record(&mut plan, did, rkey, largest)
            };
            plan.directory =
                replace_directory(&plan.directory, &path.split('/').collect::<Vec<_>>(), &uri)?;
        } else {
            let files: Vec<_> = plan
                .directory
                .entries
                .iter()
                .filter(|entry| matches!(entry.node, EntryNode::File(_)))
                .take(100)
                .cloned()
                .collect();
            if files.is_empty() {
                plan.messages.push(SplitMessage::CannotSplit {
                    files: count_files(&plan.directory),
                    size: json_size(&manifest(site, &plan.directory, created_at)),
                });
                break;
            }
            let key = format!("{site}-{generation}-subfs-{iteration}");
            let uri = add_record(&mut plan, did, key, &directory(files.clone()));
            let mut entries: Vec<_> = plan
                .directory
                .entries
                .iter()
                .filter(|entry| !files.iter().any(|file| file.name == entry.name))
                .cloned()
                .collect();
            entries.push(reference(&format!("__subfs_{iteration}"), &uri, true)?);
            plan.directory = directory(entries);
        }
    }
    Ok(plan)
}

/// The directory to split out: `dir`, or the first of its subdirectories (by
/// size, recursively) that is too big for one record on its own. Chunking only
/// divides a directory's own entries, so a too-big child would otherwise land
/// whole in a single chunk, over the record size and the lexicon's 500-entry
/// limit. (The TypeScript CLI has this bug; see the nested-icons test.)
fn splittable((path, dir): (String, Directory)) -> (String, Directory) {
    let oversized_child = dir
        .entries
        .iter()
        .filter_map(|entry| match &entry.node {
            EntryNode::Directory(child) => Some((entry.name.as_str(), child)),
            _ => None,
        })
        .max_by_key(|(_, child)| directory_size(child))
        .filter(|(_, child)| directory_size(child) > MAX_SUBFS_SIZE);
    match oversized_child {
        Some((name, child)) => splittable((format!("{path}/{name}"), (**child).clone())),
        None => (path, dir),
    }
}

/// Queue `root` as a subfs record and return the URI it will have.
fn add_record(plan: &mut SplitPlan, did: &str, rkey: String, root: &Directory) -> String {
    let uri = format!("at://{did}/place.wisp.subfs/{rkey}");
    plan.records.push(SubfsWrite {
        rkey,
        root: fs_to_subfs(root),
        file_count: count_files(root),
    });
    uri
}

fn reference(name: &str, uri: &str, flat: bool) -> Result<Entry, SplitError> {
    Ok(Entry {
        name: name.to_owned().into(),
        extra_data: None,
        node: EntryNode::Subfs(Box::new(Subfs {
            r#type: "subfs".into(),
            subject: AtUri::new(uri.to_owned().into())
                .map_err(|_| SplitError::InvalidUri(uri.into()))?,
            flat: Some(flat),
            extra_data: None,
        })),
    })
}

fn large_directories(root: &Directory, prefix: &str) -> Vec<(String, Directory)> {
    root.entries
        .iter()
        .flat_map(|entry| {
            if let EntryNode::Directory(dir) = &entry.node {
                let path = if prefix.is_empty() {
                    entry.name.to_string()
                } else {
                    format!("{prefix}/{}", entry.name)
                };
                let mut result = vec![(path.clone(), (**dir).clone())];
                result.extend(large_directories(dir, &path));
                result
            } else {
                Vec::new()
            }
        })
        .collect()
}

fn replace_directory(root: &Directory, path: &[&str], uri: &str) -> Result<Directory, SplitError> {
    let entries = root
        .entries
        .iter()
        .map(|entry| {
            if entry.name.as_str() != path[0] {
                return Ok(entry.clone());
            }
            if let EntryNode::Directory(child) = &entry.node {
                if path.len() == 1 {
                    reference(entry.name.as_str(), uri, false)
                } else {
                    Ok(Entry {
                        name: entry.name.clone(),
                        extra_data: None,
                        node: EntryNode::Directory(Box::new(replace_directory(
                            child,
                            &path[1..],
                            uri,
                        )?)),
                    })
                }
            } else {
                Ok(entry.clone())
            }
        })
        .collect::<Result<Vec<_>, SplitError>>()?;
    Ok(directory(entries))
}

pub fn split_chunks(root: &Directory, max_size: usize) -> Vec<Directory> {
    let mut chunks = Vec::new();
    let mut entries = Vec::new();
    let mut size = 100;
    for entry in &root.entries {
        let entry_size = json_size(entry);
        if !entries.is_empty() && size + entry_size > max_size {
            chunks.push(directory(std::mem::take(&mut entries)));
            size = 100;
        }
        entries.push(entry.clone());
        size += entry_size;
    }
    if !entries.is_empty() {
        chunks.push(directory(entries));
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::{UploadResult, build_tree, extract_subfs_uris};
    use serde_json::json;

    fn created() -> Datetime {
        "2026-01-01T00:00:00.000Z".parse().unwrap()
    }

    fn files(count: usize, prefix: &str) -> Directory {
        let upload = UploadResult {
            blob: serde_json::from_value(json!({
                "$type": "blob",
                "ref": { "$link": crate::blob::compute_cid(b"a") },
                "mimeType": "application/octet-stream",
                "size": 1
            }))
            .unwrap(),
            encoding: None,
            mime_type: "text/plain".into(),
            base64: false,
        };
        build_tree(
            &(0..count)
                .map(|i| (format!("{prefix}file-{i:04}.txt"), upload.clone()))
                .collect::<Vec<_>>(),
        )
    }
    #[test]
    fn chunk_limits_preserve_order_and_files() {
        let root = files(300, "");
        let chunks = split_chunks(&root, 8000);
        assert_eq!(chunks.iter().map(count_files).sum::<usize>(), 300);
        assert!(chunks.iter().all(|chunk| json_size(chunk) <= 8000));
        assert_eq!(
            chunks
                .into_iter()
                .flat_map(|chunk| chunk.entries)
                .collect::<Vec<_>>(),
            root.entries
        );
    }
    #[test]
    fn utf16_json_estimates() {
        let value = json!({"name":"🦋"});
        assert_eq!(
            json_size(&value),
            "{\"name\":\"🦋\"}".encode_utf16().count()
        );
        assert!(json_size(&value) < serde_json::to_string(&value).unwrap().len());
    }
    #[test]
    fn small_tree_is_unchanged() {
        let root = files(10, "a/b/");
        let plan = split_plan(&root, "did:plc:test", "site", "g", &created()).unwrap();
        assert_eq!(plan.directory, root);
        assert!(plan.records.is_empty());
    }
    #[test]
    fn root_chunks_and_boundary() {
        let unsplit = split_plan(&files(249, ""), "did:plc:test", "site", "g", &created()).unwrap();
        assert!(unsplit.records.is_empty());
        let plan = split_plan(&files(350, ""), "did:plc:test", "site", "g", &created()).unwrap();
        assert_eq!(plan.records.len(), 2);
        assert_eq!(count_files(&plan.directory), 150);
        assert_eq!(plan.records[0].rkey, "site-g-subfs-1");
        assert!(
            extract_subfs_uris(&plan.directory)
                .iter()
                .all(|node| node.flat)
        );
    }
    #[test]
    fn records_only_carry_their_own_lexicon_types() {
        let root = files(600, "assets/icons/");
        let plan = split_plan(&root, "did:plc:test", "site", "g", &created()).unwrap();
        for write in &plan.records {
            let json = serde_json::to_string(&subfs_record(write, &created())).unwrap();
            assert!(!json.contains("place.wisp.fs#"), "{json:.200}");
            assert!(json.starts_with(r#"{"$type":"place.wisp.subfs""#));
        }
        let manifest = serde_json::to_string(&manifest("site", &root, &created())).unwrap();
        // One `$type` per object: the manifest, the root, each directory node and file.
        let objects = 1 + 1 + 2 + 600 * 2;
        assert_eq!(manifest.matches(r#""$type""#).count(), objects);
    }

    #[test]
    fn oversized_subdirectories_are_split_themselves() {
        let plan = split_plan(
            &files(600, "assets/icons/"),
            "did:plc:test",
            "site",
            "g",
            &created(),
        )
        .unwrap();
        assert_eq!(count_files(&plan.directory), 0);
        assert_eq!(
            plan.records.iter().map(|r| r.file_count).sum::<usize>(),
            600
        );
        for write in &plan.records {
            assert!(write.root.entries.len() <= 500);
            // The chunk budget ignores commas between entries, like the old CLI,
            // so chunks can run a little over it.
            let as_fs = crate::convert::subfs_to_fs(&write.root);
            assert!(
                directory_size(&as_fs) <= MAX_SUBFS_SIZE * 21 / 20,
                "{}",
                write.rkey
            );
        }
    }

    #[test]
    fn nested_directory_chunks() {
        let plan = split_plan(
            &files(600, "assets/"),
            "did:plc:test",
            "site",
            "g",
            &created(),
        )
        .unwrap();
        assert!(plan.records.len() >= 3);
        assert_eq!(count_files(&plan.directory), 0);
        assert!(!extract_subfs_uris(&plan.directory)[0].flat);
        assert_eq!(plan.records.last().unwrap().rkey, "site-g-subfs-1");
        let parent = serde_json::to_value(&plan.records.last().unwrap().root).unwrap();
        assert!(parent["entries"][0]["node"].get("flat").is_none());
        assert_eq!(
            parent["entries"][0]["node"]["$type"],
            "place.wisp.subfs#subfs"
        );
    }
}
