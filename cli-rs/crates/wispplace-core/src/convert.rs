//! Moving trees between the `place.wisp.fs` and `place.wisp.subfs` shapes.
//! They are identical apart from their `$type`s and subfs nodes, which only
//! the fs lexicon lets mark as `flat` (`flat` absent means flat).
use std::collections::BTreeMap;

use jacquard_common::{deps::smol_str::SmolStr, types::value::Data};
use wispplace_lexicons::place_wisp::{fs, subfs};

/// Directory extras without a root `$type`, which names the source lexicon
/// and would be wrong in the other one (records re-add their own).
fn without_type(extra: &Option<BTreeMap<SmolStr, Data>>) -> Option<BTreeMap<SmolStr, Data>> {
    extra
        .as_ref()
        .map(|extra| extra.iter().filter(|(key, _)| key.as_str() != "$type"))
        .map(|entries| {
            entries
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .filter(|extra: &BTreeMap<_, _>| !extra.is_empty())
}

pub fn fs_to_subfs(dir: &fs::Directory) -> subfs::Directory {
    subfs::Directory {
        entries: dir
            .entries
            .iter()
            .map(|entry| subfs::Entry {
                name: entry.name.clone(),
                node: node_to_subfs(&entry.node),
                extra_data: entry.extra_data.clone(),
            })
            .collect(),
        r#type: dir.r#type.clone(),
        extra_data: without_type(&dir.extra_data),
    }
}

fn node_to_subfs(node: &fs::EntryNode) -> subfs::EntryNode {
    match node {
        fs::EntryNode::File(file) => subfs::EntryNode::File(Box::new(subfs::File {
            base64: file.base64,
            blob: file.blob.clone(),
            encoding: file
                .encoding
                .as_ref()
                .map(|encoding| subfs::FileEncoding::from_value(encoding.as_str().into())),
            mime_type: file.mime_type.clone(),
            r#type: file.r#type.clone(),
            extra_data: file.extra_data.clone(),
        })),
        fs::EntryNode::Directory(dir) => subfs::EntryNode::Directory(Box::new(fs_to_subfs(dir))),
        fs::EntryNode::Subfs(node) => subfs::EntryNode::Subfs(Box::new(subfs::Subfs {
            subject: node.subject.clone(),
            r#type: node.r#type.clone(),
            extra_data: node.extra_data.clone(),
        })),
        fs::EntryNode::Unknown(data) => subfs::EntryNode::Unknown(data.clone()),
    }
}

pub fn subfs_to_fs(dir: &subfs::Directory) -> fs::Directory {
    fs::Directory {
        entries: dir
            .entries
            .iter()
            .map(|entry| fs::Entry {
                name: entry.name.clone(),
                node: node_to_fs(&entry.node),
                extra_data: entry.extra_data.clone(),
            })
            .collect(),
        r#type: dir.r#type.clone(),
        extra_data: without_type(&dir.extra_data),
    }
}

fn node_to_fs(node: &subfs::EntryNode) -> fs::EntryNode {
    match node {
        subfs::EntryNode::File(file) => fs::EntryNode::File(Box::new(fs::File {
            base64: file.base64,
            blob: file.blob.clone(),
            encoding: file
                .encoding
                .as_ref()
                .map(|encoding| fs::FileEncoding::from_value(encoding.as_str().into())),
            mime_type: file.mime_type.clone(),
            r#type: file.r#type.clone(),
            extra_data: file.extra_data.clone(),
        })),
        subfs::EntryNode::Directory(dir) => fs::EntryNode::Directory(Box::new(subfs_to_fs(dir))),
        subfs::EntryNode::Subfs(node) => fs::EntryNode::Subfs(Box::new(fs::Subfs {
            flat: None,
            subject: node.subject.clone(),
            r#type: node.r#type.clone(),
            extra_data: node.extra_data.clone(),
        })),
        subfs::EntryNode::Unknown(data) => fs::EntryNode::Unknown(data.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_and_rewrites_types() {
        let fs_tree: fs::Directory = serde_json::from_value(json!({
            "$type": "place.wisp.fs#directory",
            "type": "directory",
            "entries": [
                {"name": "index.html", "node": {
                    "$type": "place.wisp.fs#file", "type": "file", "encoding": "gzip",
                    "mimeType": "text/html", "base64": false,
                    "blob": {"$type": "blob", "ref": {"$link": "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"}, "mimeType": "application/octet-stream", "size": 1}
                }},
                {"name": "docs", "node": {
                    "$type": "place.wisp.fs#subfs", "type": "subfs", "flat": true,
                    "subject": "at://did:plc:untyra7qun43gbecoft5cglc/place.wisp.subfs/x"
                }}
            ]
        }))
        .unwrap();
        let subfs_tree = fs_to_subfs(&fs_tree);
        let value = serde_json::to_value(&subfs_tree).unwrap();
        assert_eq!(
            value["entries"][0]["node"]["$type"],
            "place.wisp.subfs#file"
        );
        assert_eq!(
            value["entries"][1]["node"]["$type"],
            "place.wisp.subfs#subfs"
        );
        assert!(value["entries"][1]["node"].get("flat").is_none());

        let back = subfs_to_fs(&subfs_tree);
        let back_value = serde_json::to_value(&back).unwrap();
        assert_eq!(
            back_value["entries"][0],
            serde_json::to_value(&fs_tree).unwrap()["entries"][0]
        );
        assert_eq!(
            back_value["entries"][1]["node"]["$type"],
            "place.wisp.fs#subfs"
        );
    }
}
