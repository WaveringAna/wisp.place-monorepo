//! Fail-closed path validation shared by storage, pull, and local serving.
use std::fmt;

fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn drive_prefix(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

pub fn normalize_site_path(path: &str, allow_trailing_slash: bool) -> Option<&str> {
    if js_length(path) > 4096
        || path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path.as_bytes().windows(3).any(|part| {
            part[0] == b'%'
                && matches!(
                    (part[1].to_ascii_lowercase(), part[2].to_ascii_lowercase()),
                    (b'0' | b'1', b'0'..=b'9' | b'a'..=b'f')
                        | (b'7', b'f')
                        | (b'2', b'e' | b'f')
                        | (b'5', b'c')
                )
        })
        || path.split('/').any(drive_prefix)
    {
        return None;
    }
    if path.is_empty() {
        return Some(path);
    }
    let canonical = if let Some(path) = path.strip_suffix('/') {
        if !allow_trailing_slash || path.is_empty() || path.ends_with('/') {
            return None;
        }
        path
    } else {
        path
    };
    let segments: Vec<_> = canonical.split('/').collect();
    (segments.len() <= 128
        && segments.iter().all(|part| {
            !part.is_empty() && *part != "." && *part != ".." && js_length(part) <= 255
        }))
    .then_some(canonical)
}

/// Legacy lossy sanitizer; do not use at trust boundaries.
pub fn sanitize_path(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .map(|part| if drive_prefix(part) { &part[2..] } else { part })
        .filter(|part| {
            !part.is_empty() && *part != "." && *part != ".." && !part.chars().any(char::is_control)
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn normalize_path(path: &str) -> &str {
    path.split_once('/').map_or(path, |(_, rest)| rest)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathError;

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Site contains an invalid file path")
    }
}
impl std::error::Error for PathError {}

fn safe_local_path(path: &str) -> bool {
    !path
        .split('/')
        .any(|part| part.contains(':') || part.ends_with(['.', ' ']))
}

pub fn require_site_file_path(path: &str) -> Result<&str, PathError> {
    let canonical = normalize_site_path(path, false)
        .filter(|path| !path.is_empty())
        .ok_or(PathError)?;
    if !safe_local_path(canonical)
        || canonical.split('/').any(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                || (stem.len() == 4
                    && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
    {
        return Err(PathError);
    }
    Ok(canonical)
}

/// Input is already percent-decoded, just as in the TypeScript routing helper.
pub fn normalize_serve_request_path(pathname: &str) -> Option<String> {
    let raw = pathname.strip_prefix('/')?;
    let path = normalize_site_path(raw, true)?;
    if !safe_local_path(path) {
        return None;
    }
    Some(if path.is_empty() {
        "/".into()
    } else {
        format!("/{path}{}", if raw.ends_with('/') { "/" } else { "" })
    })
}

pub fn normalize_configured_site_path(path: &str) -> Option<&str> {
    let candidate = path.strip_prefix('/').unwrap_or(path);
    let path = normalize_site_path(candidate, false)?;
    (!path.is_empty() && safe_local_path(path)).then_some(path)
}

pub fn normalize_rewrite_path(path: &str) -> Option<String> {
    normalize_serve_request_path(path)
        .or_else(|| normalize_configured_site_path(path).map(|path| format!("/{path}")))
}

/// Strict decodeURIComponent equivalent followed by request-path validation.
pub fn decode_serve_request_path(path: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            (high * 16 + low) as u8
        } else {
            byte
        });
    }
    normalize_serve_request_path(std::str::from_utf8(&decoded).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_paths_and_trailing_slashes() {
        for path in [
            "",
            "assets/images/logo.svg",
            "did:plc:example/site/index.html",
            "café/☃.html",
        ] {
            assert_eq!(normalize_site_path(path, false), Some(path));
        }
        assert_eq!(normalize_site_path("assets/", false), None);
        assert_eq!(normalize_site_path("assets/", true), Some("assets"));
        for path in ["/", "assets//", "assets//file", "./", "../"] {
            assert_eq!(normalize_site_path(path, true), None);
        }
    }

    #[test]
    fn rejects_all_ts_attack_paths() {
        for path in [
            "/absolute/path",
            "//network/share",
            "../secret.txt",
            "nested/../secret.txt",
            "nested/./file.txt",
            "nested//file.txt",
            "..\\secret.txt",
            "nested\\file.txt",
            "C:/Windows/system.ini",
            "C:\\Windows\\system.ini",
            "assets/C:/Windows/system.ini",
            "file\0name.txt",
            "file\u{1f}name.txt",
            "file\u{7f}name.txt",
            "file\u{85}name.txt",
            "%00name.txt",
            "%2e%2e%2fsecret.txt",
            "%2E%2E%5Csecret.txt",
            "%1fname",
            "%7Fname",
        ] {
            assert_eq!(normalize_site_path(path, false), None, "{path:?}");
        }
    }

    #[test]
    fn exact_utf16_limits() {
        assert!(normalize_site_path(&"a".repeat(255), false).is_some());
        assert!(normalize_site_path(&"a".repeat(256), false).is_none());
        assert!(normalize_site_path(&"😀".repeat(127), false).is_some());
        assert!(normalize_site_path(&"😀".repeat(128), false).is_none());
        assert!(normalize_site_path(&vec!["a"; 128].join("/"), false).is_some());
        assert!(normalize_site_path(&vec!["a"; 129].join("/"), false).is_none());
        let path = vec!["a".repeat(255); 16].join("/");
        assert_eq!(path.len(), 4095);
        assert!(normalize_site_path(&path, false).is_some());
        assert!(normalize_site_path(&format!("{path}/a"), false).is_none());
    }

    #[test]
    fn legacy_sanitizers() {
        for (input, expected) in [
            ("..\\outside\\file.txt", "outside/file.txt"),
            ("C:\\sites\\index.html", "sites/index.html"),
            ("assets/C:/Windows/index.html", "assets/Windows/index.html"),
            ("nested\\..\\safe.txt", "nested/safe.txt"),
            ("/./a/../b\0/c", "a/c"),
        ] {
            assert_eq!(sanitize_path(input), expected);
        }
        assert_eq!(
            normalize_path("base/nested/index.html"),
            "nested/index.html"
        );
        assert_eq!(normalize_path("index.html"), "index.html");
    }

    #[test]
    fn pull_rejects_windows_unsafe_names() {
        for path in [
            "",
            "a:b",
            "file.",
            "file ",
            "con",
            "CON.txt",
            "x/nul.html",
            "Lpt9",
            "COM1.tar.gz",
            "prn",
            "aux",
        ] {
            assert!(require_site_file_path(path).is_err(), "{path}");
        }
        for path in [
            "index.html",
            "com0",
            "com10",
            "lpt0.txt",
            "console.txt",
            "a b/c.txt",
        ] {
            assert_eq!(require_site_file_path(path), Ok(path));
        }
    }

    #[test]
    fn serving_paths_and_strict_decoding() {
        for path in ["/", "/assets/", "/index.html", "/con"] {
            assert_eq!(normalize_serve_request_path(path), Some(path.into()));
        }
        for path in [
            "index.html",
            "//",
            "/a//",
            "/a:b",
            "/a.",
            "/a ",
            "/%2e",
            "/../x",
        ] {
            assert_eq!(normalize_serve_request_path(path), None);
        }
        for path in [
            "/%",
            "/%ff",
            "/%c0%af",
            "/%ed%a0%80",
            "/%00",
            "/%252e%252e",
            "/%2e%2e/x",
            "/%5c",
        ] {
            assert_eq!(decode_serve_request_path(path), None, "{path}");
        }
        assert_eq!(
            decode_serve_request_path("/caf%C3%A9+file"),
            Some("/café+file".into())
        );
        assert_eq!(
            normalize_configured_site_path("/index.html"),
            Some("index.html")
        );
        assert_eq!(normalize_configured_site_path("/"), None);
        assert_eq!(normalize_configured_site_path("assets/"), None);
        assert_eq!(
            normalize_rewrite_path("index.html"),
            Some("/index.html".into())
        );
    }
}
