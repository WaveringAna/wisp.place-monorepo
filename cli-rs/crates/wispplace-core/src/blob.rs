//! Byte-compatible blob preparation for the TypeScript CLI.
use crate::mime_table;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

pub fn compute_cid(bytes: &[u8]) -> String {
    let mut cid = vec![1, 0x55, 0x12, 0x20];
    cid.extend_from_slice(&Sha256::digest(bytes));
    format!(
        "b{}",
        data_encoding::BASE32_NOPAD
            .encode(&cid)
            .to_ascii_lowercase()
    )
}

pub fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .operating_system(3)
        .write(Vec::new(), flate2::Compression::best());
    encoder.write_all(bytes)?;
    encoder.finish()
}

/// gzip OS is platform-specific in Node/Bun; the payload and checksum are not.
pub fn gzip_cid_variants(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    gzip_variants(bytes).map(|variant| compute_cid(&variant))
}

pub fn gzip_variants(bytes: &[u8]) -> impl Iterator<Item = Vec<u8>> + '_ {
    [3, 19, 10, 0, 255].into_iter().map(move |os| {
        let mut variant = bytes.to_vec();
        if variant.starts_with(&[0x1f, 0x8b, 8]) && variant.len() >= 10 {
            variant[9] = os;
        }
        variant
    })
}

/// The extension `mime-types`' `lookup` keys on: Node's
/// `extname('x.' + path)`, so a bare root name like `json` counts as an
/// extension while a leading-dot name inside a directory (`a/.env`) does not.
fn lookup_extension(path: &str) -> Option<String> {
    let prefixed = format!("x.{path}");
    let base = prefixed.rsplit(['/', '\\']).next().unwrap_or(&prefixed);
    let dot = base.rfind('.')?;
    let ext = &base[dot + 1..];
    (dot > 0 && !ext.is_empty() && base != "..").then(|| ext.to_ascii_lowercase())
}

/// `lookup(path) || 'application/octet-stream'`, with the TS CLI's table.
pub fn mime_for(path: &str) -> String {
    lookup_extension(path)
        .and_then(|ext| {
            mime_table::TYPES
                .binary_search_by(|(known, _)| known.cmp(&ext.as_str()))
                .ok()
        })
        .map_or("application/octet-stream", |i| mime_table::TYPES[i].1)
        .to_owned()
}

pub fn should_compress(mime: &str, path: &str) -> bool {
    if path == "_redirects" || path.ends_with("/_redirects") {
        return false;
    }
    [
        "text/html",
        "text/css",
        "text/javascript",
        "application/javascript",
        "application/json",
        "image/svg+xml",
        "text/xml",
        "application/xml",
        "text/plain",
        "application/x-javascript",
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
        "audio/aiff",
        "audio/x-aiff",
    ]
    .iter()
    .any(|prefix| mime.starts_with(prefix))
}

pub fn is_text_mime(mime: &str) -> bool {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    // Non-text UTF-8 entries from mime-db, the database behind mime-types.
    mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/3gpdash-qoe-report+xml"
                | "application/beep+xml"
                | "application/cda+xml"
                | "application/elm+json"
                | "application/emergencycalldata.cap+xml"
                | "application/fhir+json"
                | "application/fhir+xml"
                | "application/hl7v2+xml"
                | "application/im-iscomposing+xml"
                | "application/javascript"
                | "application/json"
                | "application/manifest+json"
                | "application/msc-ivr+xml"
                | "application/msc-mixer+xml"
                | "application/pidf+xml"
                | "application/pidf-diff+xml"
                | "application/poc-settings+xml"
                | "application/vnd.omads-email+xml"
                | "application/vnd.omads-file+xml"
                | "application/vnd.omads-folder+xml"
                | "application/vnd.syncml+xml"
                | "application/vnd.syncml.dm+wbxml"
                | "application/vnd.syncml.dm+xml"
                | "application/vnd.syncml.dmddf+xml"
                | "application/vnd.syncml.dmtnds+xml"
                | "application/vnd.wap.wbxml"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The fixture inputs, rebuilt here so only their expected CIDs are checked in.
    fn fixture_input(name: &str) -> Vec<u8> {
        match name {
            "empty" => Vec::new(),
            "text" => b"hello, wisp!\n".to_vec(),
            // xorshift32 over JavaScript's int32 arithmetic, as in generate-blobs.ts.
            "random" => {
                let mut seed: i32 = 123_456_789;
                (0..1024 * 1024)
                    .map(|_| {
                        seed ^= seed.wrapping_shl(13);
                        seed ^= ((seed as u32) >> 17) as i32;
                        seed ^= seed.wrapping_shl(5);
                        (seed & 255) as u8
                    })
                    .collect()
            }
            other => panic!("unknown fixture {other}"),
        }
    }

    #[test]
    fn typescript_fixtures() {
        let meta: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/blobs.json")).unwrap();
        for fixture in meta.as_array().unwrap() {
            let name = fixture["name"].as_str().unwrap();
            let raw = fixture_input(name);
            assert_eq!(compute_cid(&raw), fixture["cid"], "{name}");
            // The TS gzip differs only in the OS header byte, so one of the
            // variants hashes to exactly the bytes it produced.
            let actual = gzip(&raw).unwrap();
            assert_eq!(actual[9], 3, "{name}");
            assert!(
                gzip_cid_variants(&actual).any(|cid| cid == fixture["gzipCid"]),
                "{name}"
            );
        }
    }

    #[test]
    fn mime_typescript_fixture() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/mime.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let path = format!("asset.{}", fixture["extension"].as_str().unwrap());
            let mime = mime_for(&path);
            assert_eq!(mime, fixture["mime"], "{path}");
            assert_eq!(
                is_text_mime(&mime),
                fixture["text"].as_bool().unwrap(),
                "{path}"
            );
        }
    }
    #[test]
    fn mime_table_is_sorted_for_binary_search() {
        assert!(mime_table::TYPES.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn lookup_uses_node_extname_of_x_dot_path() {
        assert_eq!(mime_for("json"), "application/json");
        assert_eq!(mime_for(".html"), "text/html");
        assert_eq!(mime_for("dir/.html"), "application/octet-stream");
        assert_eq!(mime_for("dir/json"), "application/octet-stream");
        assert_eq!(mime_for("Dir/INDEX.HTML"), "text/html");
        assert_eq!(mime_for("noext"), "application/octet-stream");
        assert_eq!(mime_for("a.weirdext"), "application/octet-stream");
        assert_eq!(mime_for("trailing."), "application/octet-stream");
        assert_eq!(mime_for("config.yaml"), "text/yaml");
        assert_eq!(mime_for("clip.ts"), "video/mp2t");
    }

    #[test]
    fn types_and_redirects() {
        assert_eq!(mime_for("foo.js"), "text/javascript");
        assert!(!should_compress("text/plain", "nested/_redirects"));
        assert!(should_compress("audio/wav", "a.wav"));
        assert!(is_text_mime("text/html; charset=utf-8"));
        assert!(!is_text_mime("image/svg+xml"));
    }
}
