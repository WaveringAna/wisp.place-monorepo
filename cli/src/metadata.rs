use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use miette::IntoDiagnostic;

/// Metadata tracking file CIDs for incremental updates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteMetadata {
    /// Record CID from the PDS
    pub record_cid: String,
    /// Map of file paths to their blob CIDs
    pub file_cids: HashMap<String, String>,
    /// Timestamp when the site was last synced
    pub last_sync: i64,
}

impl SiteMetadata {
    pub fn new(record_cid: String, file_cids: HashMap<String, String>) -> Self {
        Self {
            record_cid,
            file_cids,
            last_sync: chrono::Utc::now().timestamp(),
        }
    }

    /// Load metadata from a directory
    pub fn load(dir: &Path) -> miette::Result<Option<Self>> {
        let metadata_path = dir.join(".wisp-metadata.json");
        if !metadata_path.exists() {
            return Ok(None);
        }

        let contents = std::fs::read_to_string(&metadata_path).into_diagnostic()?;
        let metadata: SiteMetadata = serde_json::from_str(&contents).into_diagnostic()?;
        Ok(Some(metadata))
    }

    /// Save metadata to a directory
    pub fn save(&self, dir: &Path) -> miette::Result<()> {
        let metadata_path = dir.join(".wisp-metadata.json");
        let contents = serde_json::to_string_pretty(self).into_diagnostic()?;
        std::fs::write(&metadata_path, contents).into_diagnostic()?;
        Ok(())
    }
}

