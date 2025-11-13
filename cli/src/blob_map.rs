use jacquard_common::types::blob::BlobRef;
use jacquard_common::IntoStatic;
use std::collections::HashMap;

use crate::place_wisp::fs::{Directory, EntryNode};

/// Extract blob information from a directory tree
/// Returns a map of file paths to their blob refs and CIDs
/// 
/// This mirrors the TypeScript implementation in src/lib/wisp-utils.ts lines 275-302
pub fn extract_blob_map(
    directory: &Directory,
) -> HashMap<String, (BlobRef<'static>, String)> {
    extract_blob_map_recursive(directory, String::new())
}

fn extract_blob_map_recursive(
    directory: &Directory,
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
            EntryNode::File(file_node) => {
                // Extract CID from blob ref
                // BlobRef is an enum with Blob variant, which has a ref field (CidLink)
                let blob_ref = &file_node.blob;
                let cid_string = blob_ref.blob().r#ref.to_string();
                
                // Store with full path (mirrors TypeScript implementation)
                blob_map.insert(
                    full_path,
                    (blob_ref.clone().into_static(), cid_string)
                );
            }
            EntryNode::Directory(subdir) => {
                let sub_map = extract_blob_map_recursive(subdir, full_path);
                blob_map.extend(sub_map);
            }
            EntryNode::Unknown(_) => {
                // Skip unknown node types
            }
        }
    }
    
    blob_map
}

/// Normalize file path by removing base folder prefix
/// Example: "cobblemon/index.html" -> "index.html"
/// 
/// Note: This function is kept for reference but is no longer used in production code.
/// The TypeScript server has a similar normalization (src/routes/wisp.ts line 291) to handle
/// uploads that include a base folder prefix, but our CLI doesn't need this since we
/// track full paths consistently.
#[allow(dead_code)]
pub fn normalize_path(path: &str) -> String {
    // Remove base folder prefix (everything before first /)
    if let Some(idx) = path.find('/') {
        path[idx + 1..].to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_path() {
        assert_eq!(normalize_path("index.html"), "index.html");
        assert_eq!(normalize_path("cobblemon/index.html"), "index.html");
        assert_eq!(normalize_path("folder/subfolder/file.txt"), "subfolder/file.txt");
        assert_eq!(normalize_path("a/b/c/d.txt"), "b/c/d.txt");
    }
}

