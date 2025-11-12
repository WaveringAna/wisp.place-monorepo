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
                
                // Store both normalized and full paths
                // Normalize by removing base folder prefix (e.g., "cobblemon/index.html" -> "index.html")
                let normalized_path = normalize_path(&full_path);
                
                blob_map.insert(
                    normalized_path.clone(),
                    (blob_ref.clone().into_static(), cid_string.clone())
                );
                
                // Also store the full path for matching
                if normalized_path != full_path {
                    blob_map.insert(
                        full_path,
                        (blob_ref.clone().into_static(), cid_string)
                    );
                }
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
/// Mirrors TypeScript implementation at src/routes/wisp.ts line 291
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

