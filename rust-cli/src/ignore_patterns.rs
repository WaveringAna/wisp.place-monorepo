use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;
use miette::IntoDiagnostic;

#[derive(Debug, Deserialize, Serialize)]
struct IgnoreConfig {
    patterns: Vec<String>,
}

/// Load ignore patterns from the default .wispignore.json file
fn load_default_patterns() -> miette::Result<Vec<String>> {
    // Path to the default ignore patterns JSON file (in the monorepo root)
    let default_json_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../.wispignore.json");

    match std::fs::read_to_string(default_json_path) {
        Ok(contents) => {
            let config: IgnoreConfig = serde_json::from_str(&contents).into_diagnostic()?;
            Ok(config.patterns)
        }
        Err(_) => {
            // If the default file doesn't exist, return hardcoded patterns as fallback
            eprintln!("⚠️  Default .wispignore.json not found, using hardcoded patterns");
            Ok(get_hardcoded_patterns())
        }
    }
}

/// Hardcoded fallback patterns (same as in .wispignore.json)
fn get_hardcoded_patterns() -> Vec<String> {
    vec![
        ".git".to_string(),
        ".git/**".to_string(),
        ".github".to_string(),
        ".github/**".to_string(),
        ".gitlab".to_string(),
        ".gitlab/**".to_string(),
        ".DS_Store".to_string(),
        ".wisp.metadata.json".to_string(),
        ".env".to_string(),
        ".env.*".to_string(),
        "node_modules".to_string(),
        "node_modules/**".to_string(),
        "Thumbs.db".to_string(),
        "desktop.ini".to_string(),
        "._*".to_string(),
        ".Spotlight-V100".to_string(),
        ".Spotlight-V100/**".to_string(),
        ".Trashes".to_string(),
        ".Trashes/**".to_string(),
        ".fseventsd".to_string(),
        ".fseventsd/**".to_string(),
        ".cache".to_string(),
        ".cache/**".to_string(),
        ".temp".to_string(),
        ".temp/**".to_string(),
        ".tmp".to_string(),
        ".tmp/**".to_string(),
        "__pycache__".to_string(),
        "__pycache__/**".to_string(),
        "*.pyc".to_string(),
        ".venv".to_string(),
        ".venv/**".to_string(),
        "venv".to_string(),
        "venv/**".to_string(),
        "env".to_string(),
        "env/**".to_string(),
        "*.swp".to_string(),
        "*.swo".to_string(),
        "*~".to_string(),
        ".tangled".to_string(),
        ".tangled/**".to_string(),
    ]
}

/// Load custom ignore patterns from a .wispignore file in the given directory
fn load_wispignore_file(dir_path: &Path) -> miette::Result<Vec<String>> {
    let wispignore_path = dir_path.join(".wispignore");

    if !wispignore_path.exists() {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(&wispignore_path).into_diagnostic()?;

    // Parse gitignore-style file (one pattern per line, # for comments)
    let patterns: Vec<String> = contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                None
            } else {
                Some(line.to_string())
            }
        })
        .collect();

    if !patterns.is_empty() {
        println!("Loaded {} custom patterns from .wispignore", patterns.len());
    }

    Ok(patterns)
}

/// Build a GlobSet from a list of patterns
fn build_globset(patterns: Vec<String>) -> miette::Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();

    for pattern in patterns {
        let glob = Glob::new(&pattern).into_diagnostic()?;
        builder.add(glob);
    }

    let globset = builder.build().into_diagnostic()?;
    Ok(globset)
}

/// IgnoreMatcher handles checking if paths should be ignored
pub struct IgnoreMatcher {
    globset: GlobSet,
}

impl IgnoreMatcher {
    /// Create a new IgnoreMatcher for the given directory
    /// Loads default patterns and any custom .wispignore file
    pub fn new(dir_path: &Path) -> miette::Result<Self> {
        let mut all_patterns = load_default_patterns()?;

        // Load custom patterns from .wispignore
        let custom_patterns = load_wispignore_file(dir_path)?;
        all_patterns.extend(custom_patterns);

        let globset = build_globset(all_patterns)?;

        Ok(Self { globset })
    }

    /// Check if the given path (relative to site root) should be ignored
    pub fn is_ignored(&self, path: &str) -> bool {
        self.globset.is_match(path)
    }

    /// Check if a filename should be ignored (checks just the filename, not full path)
    pub fn is_filename_ignored(&self, filename: &str) -> bool {
        self.globset.is_match(filename)
    }
}
