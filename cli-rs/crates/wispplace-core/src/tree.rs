//! Typed trees assembled from path-based upload results without retaining bytes.
use jacquard_common::deps::smol_str::SmolStr;
use jacquard_common::types::{blob::BlobRef, string::AtprotoStr, value::Data};
use std::collections::BTreeMap;
use wispplace_lexicons::place_wisp::fs::{Directory, Entry, EntryNode, File};

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub blob: BlobRef,
    pub encoding: Option<String>,
    pub mime_type: String,
    pub base64: bool,
}

/// A directory node. Its `$type` comes from the enclosing union tag, or from
/// [`root_type`] when it is a record's root.
pub fn directory(entries: Vec<Entry>) -> Directory {
    Directory {
        entries,
        r#type: "directory".into(),
        extra_data: None,
    }
}

/// `extra_data` giving a record's root directory an explicit `$type` field,
/// as the TypeScript CLI writes it. Nested directories must not carry one:
/// their union tag already serializes `$type`.
pub fn root_type(def: &str) -> Option<BTreeMap<SmolStr, Data>> {
    Some(BTreeMap::from([(
        "$type".into(),
        Data::String(AtprotoStr::new(def.into())),
    )]))
}

pub fn build_tree(files: &[(String, UploadResult)]) -> Directory {
    let valid: Vec<_> = files
        .iter()
        .filter(|(path, _)| !path.is_empty() && path != ".git" && !path.starts_with(".git/"))
        .collect();
    let mut root = directory(Vec::new());
    for (path, upload) in valid.iter().filter(|(path, _)| !path.contains('/')) {
        root.entries.push(file_entry(path, upload));
    }
    for (path, upload) in valid.iter().filter(|(path, _)| path.contains('/')) {
        insert(&mut root, &path.split('/').collect::<Vec<_>>(), upload);
    }
    root
}

fn file_entry(name: &str, upload: &UploadResult) -> Entry {
    Entry {
        name: name.to_owned().into(),
        extra_data: None,
        node: EntryNode::File(Box::new(File {
            r#type: "file".into(),
            blob: upload.blob.clone(),
            encoding: upload.encoding.as_ref().map(|encoding| {
                wispplace_lexicons::place_wisp::fs::FileEncoding::from_value(
                    encoding.clone().into(),
                )
            }),
            mime_type: Some(upload.mime_type.clone().into()),
            base64: Some(upload.base64),
            extra_data: None,
        })),
    }
}

fn insert(dir: &mut Directory, parts: &[&str], upload: &UploadResult) {
    if parts.len() == 1 {
        dir.entries.push(file_entry(parts[0], upload));
        return;
    }
    let index = dir
        .entries
        .iter()
        .position(|entry| entry.name.as_str() == parts[0])
        .unwrap_or_else(|| {
            dir.entries.push(Entry {
                name: parts[0].to_owned().into(),
                extra_data: None,
                node: EntryNode::Directory(Box::new(directory(Vec::new()))),
            });
            dir.entries.len() - 1
        });
    if let EntryNode::Directory(child) = &mut dir.entries[index].node {
        insert(child, &parts[1..], upload);
    }
}

pub fn count_files(dir: &Directory) -> usize {
    dir.entries
        .iter()
        .map(|entry| match &entry.node {
            EntryNode::File(_) => 1,
            EntryNode::Directory(child) => count_files(child),
            _ => 0,
        })
        .sum()
}

#[derive(Debug, Clone)]
pub struct ExistingBlob {
    pub blob: BlobRef,
    pub cid: String,
}

pub fn extract_blob_map(dir: &Directory) -> BTreeMap<String, ExistingBlob> {
    let mut result = BTreeMap::new();
    walk_blobs(dir, "", &mut result);
    result
}

fn walk_blobs(dir: &Directory, prefix: &str, result: &mut BTreeMap<String, ExistingBlob>) {
    for entry in &dir.entries {
        let path = joined(prefix, entry.name.as_str());
        match &entry.node {
            EntryNode::File(file) => {
                result.insert(
                    path,
                    ExistingBlob {
                        blob: file.blob.clone(),
                        cid: file.blob.blob().cid().to_string(),
                    },
                );
            }
            EntryNode::Directory(child) => walk_blobs(child, &path, result),
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubfsReference {
    pub path: String,
    pub uri: String,
    pub flat: bool,
}

pub fn extract_subfs_uris(dir: &Directory) -> Vec<SubfsReference> {
    fn walk(dir: &Directory, prefix: &str, result: &mut Vec<SubfsReference>) {
        for entry in &dir.entries {
            let path = joined(prefix, entry.name.as_str());
            match &entry.node {
                EntryNode::Subfs(node) => result.push(SubfsReference {
                    path,
                    uri: node.subject.to_string(),
                    flat: node.flat.unwrap_or(true),
                }),
                EntryNode::Directory(child) => walk(child, &path, result),
                _ => {}
            }
        }
    }
    let mut result = Vec::new();
    walk(dir, "", &mut result);
    result
}

fn joined(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.into()
    } else {
        format!("{prefix}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn upload() -> UploadResult {
        UploadResult {
            blob: serde_json::from_value(serde_json::json!({
                "$type": "blob",
                "ref": { "$link": crate::blob::compute_cid(b"hello") },
                "mimeType": "application/octet-stream",
                "size": 5
            }))
            .unwrap(),
            encoding: Some("gzip".into()),
            mime_type: "text/html".into(),
            base64: false,
        }
    }
    #[test]
    fn invalid_and_git_paths_do_not_create_files() {
        let tree = build_tree(&[
            ("".into(), upload()),
            (".git/config".into(), upload()),
            ("ok.txt".into(), upload()),
        ]);
        assert_eq!(count_files(&tree), 1);
        assert_eq!(
            extract_blob_map(&tree).keys().collect::<Vec<_>>(),
            ["ok.txt"]
        );
    }
    #[test]
    fn nested_paths_and_metadata() {
        let tree = build_tree(&[
            ("a/b/index.html".into(), upload()),
            ("index.html".into(), upload()),
            ("a/other.html".into(), upload()),
        ]);
        assert_eq!(count_files(&tree), 3);
        assert_eq!(tree.entries[0].name.as_str(), "index.html");
        let map = extract_blob_map(&tree);
        assert!(map.contains_key("a/b/index.html"));
        let root = Directory {
            extra_data: root_type("place.wisp.fs#directory"),
            ..tree
        };
        let json = serde_json::to_value(root).unwrap();
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/tree.json")).unwrap();
        assert_eq!(json, expected);
        assert_eq!(json["$type"], "place.wisp.fs#directory");
        assert_eq!(json["entries"][0]["node"]["base64"], false);
        assert_eq!(json["entries"][0]["node"]["encoding"], "gzip");
    }
}
