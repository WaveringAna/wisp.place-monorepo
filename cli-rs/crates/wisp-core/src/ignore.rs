//! Deterministic scans using only wisp ignore rules, not ambient git settings.
use crate::constants::DEFAULT_IGNORE_PATTERNS;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    pub path: PathBuf,
    pub relative_path: String,
    pub size: u64,
}

pub fn matcher(root: &Path, custom: &str) -> Result<Gitignore, ignore::Error> {
    let mut builder = GitignoreBuilder::new(root);
    builder.case_insensitive(true)?;
    for line in DEFAULT_IGNORE_PATTERNS
        .iter()
        .copied()
        .chain(custom.lines().map(str::trim))
    {
        if !line.is_empty() && !line.starts_with('#') {
            builder.add_line(None, line)?;
        }
    }
    builder.build()
}

pub fn collect_files(root: &Path) -> io::Result<Vec<FileInfo>> {
    let custom = match std::fs::read_to_string(root.join(".wispignore")) {
        Ok(content) => content,
        Err(err) if err.kind() == io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err),
    };
    let matcher = matcher(root, &custom).map_err(io::Error::other)?;
    let mut result = Vec::new();
    scan(root, root, &matcher, &mut result)?;
    result.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(result)
}

fn scan(
    root: &Path,
    dir: &Path,
    matcher: &Gitignore,
    result: &mut Vec<FileInfo>,
) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if matcher
            .matched_path_or_any_parents(&path, kind.is_dir())
            .is_ignore()
        {
            continue;
        }
        if kind.is_dir() {
            scan(root, &path, matcher, result)?;
        } else if kind.is_file() {
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            result.push(FileInfo {
                relative_path: relative
                    .components()
                    .map(|p| p.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/"),
                size: entry.metadata()?.len(),
                path,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sorted_scan_prunes_directories_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("nested")).unwrap();
        std::fs::create_dir(root.path().join("node_modules")).unwrap();
        for path in [
            "z.html",
            "a.html",
            "nested/x.txt",
            "nested/keep.txt",
            "node_modules/a.js",
        ] {
            std::fs::write(root.path().join(path), b"hello").unwrap();
        }
        std::fs::write(root.path().join(".wispignore"), "*.txt\n!keep.txt\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path().join("a.html"), root.path().join("link.html"))
            .unwrap();
        let files = collect_files(root.path()).unwrap();
        assert_eq!(
            files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["a.html", "nested/keep.txt", "z.html"]
        );
        assert!(files.iter().all(|file| file.size == 5));
    }
    #[test]
    fn defaults_and_negations() {
        let root = Path::new("/site");
        let ig = matcher(root, "*.txt\n!keep.txt\nassets/\n").unwrap();
        assert!(ig.matched(root.join(".env"), false).is_ignore());
        assert!(ig.matched(root.join(".ENV"), false).is_ignore());
        assert!(ig.matched(root.join("a.txt"), false).is_ignore());
        assert!(!ig.matched(root.join("keep.txt"), false).is_ignore());
        assert!(ig.matched(root.join("assets"), true).is_ignore());
        assert!(!ig.matched(root.join("assets"), false).is_ignore());
    }
}
