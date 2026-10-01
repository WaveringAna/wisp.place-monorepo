use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine, alphabet,
    engine::general_purpose::{GeneralPurpose, NO_PAD},
};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wispplace_core::{
    constants::{MAX_BLOB_SIZE, MAX_SITE_SIZE_SUPPORTER},
    path::require_site_file_path,
    subfs::{ExpansionError, ExpansionLimits, expand_subfs, validate_fs_record},
};
use wispplace_ui::{Direction, Line, s};

use crate::cli::PullArgs;

const RECORD_LIMIT: usize = 1024 * 1024;
const METADATA_FILE: &str = ".wisp-metadata.json";

#[derive(Debug)]
pub struct PullResult {
    pub did: String,
    pub pds: String,
    pub file_count: usize,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    record_cid: String,
    file_cids: BTreeMap<String, String>,
    last_sync: u64,
}

#[derive(Debug)]
struct SiteFile {
    path: String,
    cid: String,
    owner_did: String,
    gzip: bool,
    base64: bool,
}

pub async fn run(args: PullArgs) -> Result<()> {
    pull_site(&args.handle, &args.site, &args.path).await?;
    Ok(())
}

pub async fn resolve_identity(identifier: &str) -> Result<(String, String)> {
    crate::xrpc::resolve_identity(identifier).await
}

type EndpointCell = Arc<tokio::sync::OnceCell<String>>;

#[derive(Clone)]
struct SourceEndpoints(Arc<tokio::sync::Mutex<BTreeMap<String, EndpointCell>>>);

impl SourceEndpoints {
    fn new(did: &str, pds: &str) -> Self {
        let root = Arc::new(tokio::sync::OnceCell::new_with(Some(pds.to_owned())));
        Self(Arc::new(tokio::sync::Mutex::new(BTreeMap::from([(
            did.to_owned(),
            root,
        )]))))
    }

    async fn get(&self, did: &str) -> Result<String> {
        let cell = self
            .0
            .lock()
            .await
            .entry(did.to_owned())
            .or_default()
            .clone();
        let endpoint = cell
            .get_or_try_init(|| async { resolve_identity(did).await.map(|(_, pds)| pds) })
            .await?;
        Ok(endpoint.clone())
    }
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()?)
}

pub async fn fetch_record(pds: &str, did: &str, collection: &str, rkey: &str) -> Result<Value> {
    let http = client()?;
    tokio::time::timeout(Duration::from_secs(10), async {
        let response = http
            .get(format!(
                "{}/xrpc/com.atproto.repo.getRecord",
                pds.trim_end_matches('/')
            ))
            .query(&[("repo", did), ("collection", collection), ("rkey", rkey)])
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "Failed to fetch record: {}",
            response.status().as_u16()
        );
        let bytes = read_bounded_response(response, RECORD_LIMIT).await?;
        let record: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            record.is_object()
                && record.get("value").is_some()
                && record.get("cid").is_none_or(Value::is_string),
            "PDS returned an invalid record response"
        );
        Ok(record)
    })
    .await
    .context("PDS record request timed out")?
}

fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<()> {
    ensure!(
        chunk.len() <= limit.saturating_sub(bytes.len()),
        "Downloaded blob exceeds the {limit}-byte limit"
    );
    bytes.extend_from_slice(chunk);
    Ok(())
}

async fn read_bounded_response(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        append_bounded(&mut bytes, &chunk, limit)?;
    }
    Ok(bytes)
}

fn decompress_pulled_gzip(bytes: &[u8], limit: u64) -> Result<Vec<u8>> {
    ensure!(
        limit <= MAX_BLOB_SIZE,
        "Pulled gzip output limit must be within the blob limit"
    );
    ensure!(
        bytes.starts_with(&[0x1f, 0x8b]),
        "Blob is marked gzip but is not a gzip stream"
    );
    let mut output = Vec::new();
    flate2::read::MultiGzDecoder::new(bytes)
        .take(limit + 1)
        .read_to_end(&mut output)
        .context("Could not safely decompress gzip blob")?;
    ensure!(
        output.len() as u64 <= limit,
        "Could not safely decompress gzip blob"
    );
    Ok(output)
}

fn reserve(total: &mut u64, bytes: u64, limit: u64) -> Result<()> {
    ensure!(
        bytes <= limit.saturating_sub(*total),
        "Pulled site exceeds the {limit}-byte logical size limit"
    );
    *total += bytes;
    Ok(())
}

pub fn resolve_pull_file_path(
    root: &Path,
    site_path: &str,
    create_parents: bool,
) -> Result<PathBuf> {
    let normalized = require_site_file_path(site_path)?;
    let root_info = fs::symlink_metadata(root)?;
    ensure!(
        root_info.is_dir() && !root_info.file_type().is_symlink(),
        "Pull root must be a directory, not a symbolic link"
    );
    let root = fs::canonicalize(root)?;
    let parts: Vec<_> = normalized.split('/').collect();
    let mut directory = root.clone();
    for segment in &parts[..parts.len() - 1] {
        directory.push(segment);
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create_parents {
                    continue;
                }
                fs::create_dir(&directory)?;
            }
            Err(error) => return Err(error.into()),
            Ok(info) => ensure!(
                info.is_dir() && !info.file_type().is_symlink(),
                "Pull path contains an unsafe directory"
            ),
        }
    }
    let target = root.join(normalized);
    ensure!(
        target.starts_with(&root) && target != root,
        "Resolved pull path escapes its root"
    );
    if let Ok(info) = fs::symlink_metadata(&target) {
        ensure!(
            !info.file_type().is_symlink(),
            "Pull path resolves to a symbolic link"
        );
    }
    Ok(target)
}

fn collect_files(root: &Value, owners: &BTreeMap<String, String>) -> Result<Vec<SiteFile>> {
    fn collect(
        node: &Value,
        parent: &str,
        owners: &BTreeMap<String, String>,
        seen: &mut BTreeSet<String>,
        files: &mut Vec<SiteFile>,
    ) -> Result<()> {
        for entry in node["entries"]
            .as_array()
            .context("Invalid directory entries")?
        {
            let name = entry["name"].as_str().context("Invalid entry name")?;
            require_site_file_path(name)?;
            ensure!(
                !name.contains('/'),
                "Site entry names must be single path segments"
            );
            let path = if parent.is_empty() {
                name.to_owned()
            } else {
                format!("{parent}/{name}")
            };
            ensure!(
                seen.insert(path.clone()),
                "Site contains duplicate file paths"
            );
            let node = &entry["node"];
            match node["type"].as_str() {
                Some("directory") => collect(node, &path, owners, seen, files)?,
                Some("file") => {
                    let cid = node["blob"]["ref"]["$link"]
                        .as_str()
                        .or_else(|| node["blob"]["ref"].as_str())
                        .context("Invalid blob CID")?;
                    ensure!(
                        jacquard::types::string::Cid::Str(cid.to_owned()).is_valid(),
                        "Invalid blob CID"
                    );
                    let owner_did = owners
                        .get(&path)
                        .context("Expanded file is missing its source repository")?
                        .clone();
                    files.push(SiteFile {
                        path,
                        cid: cid.to_owned(),
                        owner_did,
                        gzip: node["encoding"] == "gzip",
                        base64: node["base64"] == true,
                    });
                }
                Some("subfs") => bail!("Site contains an unexpanded node"),
                _ => {}
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    collect(root, "", owners, &mut BTreeSet::new(), &mut files)?;
    Ok(files)
}

fn decode_pulled_base64(bytes: &[u8]) -> Result<Vec<u8>> {
    // Node accepts URL-safe symbols, ignored junk and partial final quanta.
    let mut cleaned: Vec<u8> = bytes
        .iter()
        .copied()
        .take_while(|&byte| byte != b'=')
        .filter_map(|byte| match byte {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/') => Some(byte),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        NO_PAD.with_decode_allow_trailing_bits(true),
    );
    Ok(engine.decode(cleaned)?)
}

async fn download_blob(http: &reqwest::Client, pds: &str, file: &SiteFile) -> Result<Vec<u8>> {
    tokio::time::timeout(Duration::from_secs(300), async {
        let response = http
            .get(format!(
                "{}/xrpc/com.atproto.sync.getBlob",
                pds.trim_end_matches('/')
            ))
            .query(&[("did", &file.owner_did), ("cid", &file.cid)])
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "Failed to download blob {}: {}",
            file.cid,
            response.status().as_u16()
        );
        let mut content = read_bounded_response(response, MAX_BLOB_SIZE as usize).await?;
        if file.base64 {
            content = decode_pulled_base64(&content)?;
        }
        if file.gzip {
            content = tokio::task::spawn_blocking(move || {
                decompress_pulled_gzip(&content, MAX_BLOB_SIZE)
            })
            .await??;
        }
        Ok(content)
    })
    .await
    .context("PDS blob request timed out")?
}

fn load_metadata(root: &Path) -> Metadata {
    fs::symlink_metadata(root.join(METADATA_FILE))
        .ok()
        .filter(|info| info.is_file() && !info.file_type().is_symlink())
        .and_then(|_| fs::read(root.join(METADATA_FILE)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn replace_directory(temp: &Path, output: &Path) -> Result<()> {
    if output.exists() {
        let backup = tempfile::Builder::new()
            .prefix(".wisp-backup-")
            .tempdir_in(output.parent().context("Output has no parent")?)?;
        let original = backup.path().join("original");
        fs::rename(output, &original)?;
        if let Err(error) = fs::rename(temp, output) {
            if fs::rename(&original, output).is_err() {
                let recovery = backup.keep();
                return Err(error).with_context(|| {
                    format!(
                        "Could not replace output; original remains at {}",
                        recovery.join("original").display()
                    )
                });
            }
            return Err(error.into());
        }
    } else {
        fs::rename(temp, output)?;
    }
    Ok(())
}

pub async fn pull_site(identifier: &str, site: &str, output: &Path) -> Result<PullResult> {
    wispplace_ui::blank();
    wispplace_ui::note(Line::from(vec![
        s::accent("Pulling "),
        s::bold(site.to_owned()),
        s::accent(format!(" from {identifier}")),
    ]));
    wispplace_ui::blank();
    let resolving = wispplace_ui::spinner("Resolving identity...");
    let (did, pds) = match resolve_identity(identifier).await {
        Ok(identity) => identity,
        Err(error) => {
            resolving.fail(Some("Failed to resolve identity".into()));
            return Err(error);
        }
    };
    resolving.succeed(Some(format!("Resolved to {did}")));
    wispplace_ui::spinner("Getting PDS endpoint...").succeed(Some("Got PDS endpoint".into()));
    let fetching = wispplace_ui::spinner("Fetching site record...");
    let response = match fetch_record(&pds, &did, "place.wisp.fs", site).await {
        Ok(record) => record,
        Err(_) => {
            fetching.fail(Some("Site not found".into()));
            bail!("Site not found: {site}");
        }
    };
    let value = &response["value"];
    let validation = validate_fs_record(value);
    if validation.is_err() {
        fetching.fail(Some("Site record is invalid".into()));
        bail!("Site record is invalid");
    }
    fetching.succeed(Some("Fetched site record".into()));
    let expanding = wispplace_ui::spinner("Expanding subfs nodes...");
    let sources = SourceEndpoints::new(&did, &pds);
    let expanded = expand_subfs(
        value["root"].clone(),
        &did,
        ExpansionLimits {
            max_entries: 4_000,
            ..ExpansionLimits::default()
        },
        |subject| {
            let sources = sources.clone();
            async move {
                let source_pds = sources
                    .get(&subject.repo)
                    .await
                    .map_err(|_| ExpansionError::FetchFailed)?;
                let response = fetch_record(
                    &source_pds,
                    &subject.repo,
                    &subject.collection,
                    &subject.rkey,
                )
                .await
                .map_err(|_| ExpansionError::FetchFailed)?;
                Ok(Some(response["value"].clone()))
            }
        },
    )
    .await;
    let expanded = match expanded {
        Ok(expanded) => expanded,
        Err(error) => {
            expanding.fail(Some("Could not expand SubFS nodes".into()));
            return Err(error.into());
        }
    };
    expanding.succeed(Some("Expanded SubFS nodes".into()));
    let output = std::path::absolute(output)?;
    if let Ok(info) = fs::symlink_metadata(&output) {
        ensure!(
            info.is_dir() && !info.file_type().is_symlink(),
            "Output path must be a directory, not a symbolic link"
        );
    }
    let metadata = load_metadata(&output);
    for path in metadata.file_cids.keys() {
        require_site_file_path(path)?;
    }
    let files = collect_files(&expanded.root, &expanded.owner_did_by_file_path)?;
    let result = PullResult {
        did: did.clone(),
        pds: pds.clone(),
        file_count: files.len(),
    };
    let (unchanged, downloads): (Vec<_>, Vec<_>) = files.iter().partition(|file| {
        metadata.file_cids.get(&file.path) == Some(&file.cid)
            && resolve_pull_file_path(&output, &file.path, false)
                .ok()
                .is_some_and(|path| path.is_file())
    });
    wispplace_ui::note(Line::from(s::muted(format!(
        "Files to download: {}, unchanged: {}",
        downloads.len(),
        unchanged.len()
    ))));
    let mut total = 0;
    if downloads.is_empty() && !unchanged.is_empty() {
        for file in &unchanged {
            reserve(
                &mut total,
                fs::metadata(resolve_pull_file_path(&output, &file.path, false)?)?.len(),
                MAX_SITE_SIZE_SUPPORTER,
            )?;
        }
        wispplace_ui::success("Site is already up to date");
        return Ok(result);
    }
    let parent = output.parent().context("Output has no parent")?;
    fs::create_dir_all(parent)?;
    let temp = tempfile::Builder::new()
        .prefix(".wisp-pull-")
        .tempdir_in(parent)?;
    let http = client()?;
    let owners: BTreeSet<_> = downloads.iter().map(|file| &file.owner_did).collect();
    let mut endpoints = BTreeMap::new();
    for owner in owners {
        endpoints.insert(owner.clone(), sources.get(owner).await?);
    }
    let progress = wispplace_ui::progress("Downloading", downloads.len() as u64, Direction::Down);
    let mut stream = futures_util::stream::iter(downloads.iter().map(|file| {
        let endpoint = &endpoints[&file.owner_did];
        let http = &http;
        let progress = &progress;
        async move {
            let item = progress.start_item(file.path.clone(), "");
            let content = download_blob(http, endpoint, file).await?;
            progress.finish_item(item);
            Ok::<_, anyhow::Error>((*file, content))
        }
    }))
    .buffer_unordered(3);
    let mut new_cids = BTreeMap::new();
    while let Some((file, content)) = stream.try_next().await? {
        reserve(&mut total, content.len() as u64, MAX_SITE_SIZE_SUPPORTER)?;
        fs::write(
            resolve_pull_file_path(temp.path(), &file.path, true)?,
            content,
        )?;
        new_cids.insert(file.path.clone(), file.cid.clone());
        progress.advance(1);
    }
    drop(stream);
    progress.succeed(format!("Downloaded {} files", downloads.len()));
    if !unchanged.is_empty() {
        let copying =
            wispplace_ui::spinner(format!("Copying {} unchanged files...", unchanged.len()));
        for file in unchanged {
            let source = resolve_pull_file_path(&output, &file.path, false)?;
            reserve(
                &mut total,
                fs::metadata(&source)?.len(),
                MAX_SITE_SIZE_SUPPORTER,
            )?;
            fs::copy(
                source,
                resolve_pull_file_path(temp.path(), &file.path, true)?,
            )?;
            new_cids.insert(file.path.clone(), file.cid.clone());
        }
        copying.succeed(Some(format!(
            "Copied {} unchanged files",
            new_cids.len() - downloads.len()
        )));
    }
    let metadata = Metadata {
        record_cid: response["cid"].as_str().unwrap_or("").into(),
        file_cids: new_cids,
        last_sync: timestamp(),
    };
    fs::write(
        temp.path().join(METADATA_FILE),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    replace_directory(temp.path(), &output)?;
    wispplace_ui::blank();
    wispplace_ui::success(format!("Pulled {site} to {}", output.display()));
    wispplace_ui::blank();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn node_base64_compatibility() {
        for (input, expected) in [
            ("aGVsbG8=", &b"hello"[..]),
            ("aG V!sbG8", &b"hello"[..]),
            ("_w", &[255][..]),
            ("ZgA", &[102, 0][..]),
            ("Zh", &b"f"[..]),
            ("a", &b""[..]),
            ("aGVsbG8=ignored", &b"hello"[..]),
        ] {
            assert_eq!(
                decode_pulled_base64(input.as_bytes()).unwrap(),
                expected,
                "{input}"
            );
        }
    }

    #[tokio::test]
    async fn root_source_endpoint_is_reused() {
        let sources = SourceEndpoints::new("did:plc:root", "http://localhost:3300");
        assert_eq!(
            sources.get("did:plc:root").await.unwrap(),
            "http://localhost:3300"
        );
        assert_eq!(sources.0.lock().await.len(), 1);
    }

    #[test]
    fn collect_preserves_nested_owner_and_blob_encoding() {
        let root = serde_json::json!({"entries":[{"name":"assets","node":{"type":"directory","entries":[{"name":"app.js","node":{"type":"file","blob":{"ref":{"$link":"bafkreid66a42la6gporhibmglielca4svkphlib7alhifi5ud7lhdxafoa"}},"encoding":"gzip","base64":true}}]}}]});
        let owners = BTreeMap::from([("assets/app.js".into(), "did:plc:child".into())]);
        let files = collect_files(&root, &owners).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "assets/app.js");
        assert_eq!(files[0].owner_did, "did:plc:child");
        assert_eq!(
            files[0].cid,
            "bafkreid66a42la6gporhibmglielca4svkphlib7alhifi5ud7lhdxafoa"
        );
        assert!(files[0].gzip && files[0].base64);
    }

    #[test]
    fn collect_rejects_duplicates_and_missing_provenance() {
        let entry = serde_json::json!({"name":"index.html","node":{"type":"file","blob":{"ref":{"$link":"bafkreid66a42la6gporhibmglielca4svkphlib7alhifi5ud7lhdxafoa"}}}});
        let owners = BTreeMap::from([("index.html".into(), "did:plc:owner".into())]);
        let root = serde_json::json!({"entries":[entry.clone(),entry.clone()]});
        assert!(
            collect_files(&root, &owners)
                .unwrap_err()
                .to_string()
                .contains("duplicate")
        );
        let root = serde_json::json!({"entries":[entry]});
        assert!(
            collect_files(&root, &BTreeMap::new())
                .unwrap_err()
                .to_string()
                .contains("source repository")
        );
    }

    #[test]
    fn canonical_pull_paths() {
        let root = tempfile::tempdir().unwrap();
        let target = resolve_pull_file_path(root.path(), "assets/app.js", true).unwrap();
        assert_eq!(
            target,
            fs::canonicalize(root.path()).unwrap().join("assets/app.js")
        );
        for path in [
            "../outside.txt",
            "..\\outside.txt",
            "C:/outside.txt",
            "C:\\outside.txt",
            "nested//file.txt",
            "index.html:stream",
            "file.",
            "file ",
            "CON.txt",
        ] {
            assert!(
                resolve_pull_file_path(root.path(), path, true).is_err(),
                "{path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_child_final_and_root_symlinks() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        symlink(outside.path(), root.path().join("assets/linked")).unwrap();
        symlink(
            outside.path().join("target.txt"),
            root.path().join("file.txt"),
        )
        .unwrap();
        symlink(root.path(), outside.path().join("root-link")).unwrap();
        assert!(
            resolve_pull_file_path(root.path(), "assets/linked/escape.txt", true)
                .unwrap_err()
                .to_string()
                .contains("unsafe directory")
        );
        assert!(
            resolve_pull_file_path(root.path(), "file.txt", true)
                .unwrap_err()
                .to_string()
                .contains("symbolic link")
        );
        assert!(
            resolve_pull_file_path(&outside.path().join("root-link"), "inside.txt", true)
                .unwrap_err()
                .to_string()
                .contains("Pull root")
        );
    }

    #[test]
    fn rejects_oversized_gzip() {
        assert!(
            decompress_pulled_gzip(&gzip(&vec![b'x'; 8192]), 1024)
                .unwrap_err()
                .to_string()
                .contains("safely decompress")
        );
    }

    #[test]
    fn accepts_inclusive_gzip_limit() {
        let original = vec![b'x'; 1024];
        assert_eq!(
            decompress_pulled_gzip(&gzip(&original), 1024).unwrap(),
            original
        );
    }

    #[test]
    fn rejects_false_gzip_header() {
        assert!(
            decompress_pulled_gzip(b"plain text", 100)
                .unwrap_err()
                .to_string()
                .contains("not a gzip stream")
        );
    }

    #[test]
    fn inclusive_site_budget() {
        let mut total = 0;
        reserve(&mut total, 6, 10).unwrap();
        reserve(&mut total, 4, 10).unwrap();
        assert_eq!(total, 10);
        assert!(
            reserve(&mut total, 1, 10)
                .unwrap_err()
                .to_string()
                .contains("logical size limit")
        );
        assert_eq!(total, 10);
    }

    #[test]
    fn rejects_oversized_chunk_before_retention() {
        let mut bytes = Vec::new();
        assert!(
            append_bounded(&mut bytes, &vec![0; 1025], 1024)
                .unwrap_err()
                .to_string()
                .contains("1024-byte limit")
        );
        assert!(bytes.is_empty());
    }

    #[test]
    fn inclusive_blob_limit() {
        let mut bytes = Vec::new();
        append_bounded(&mut bytes, &vec![b'x'; 1024], 1024).unwrap();
        assert_eq!(bytes, vec![b'x'; 1024]);
    }

    #[test]
    fn atomic_swap_removes_old_tree() {
        let parent = tempfile::tempdir().unwrap();
        let output = parent.path().join("site");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("old"), b"old").unwrap();
        let temp = tempfile::tempdir_in(parent.path()).unwrap();
        fs::write(temp.path().join("new"), b"new").unwrap();
        replace_directory(temp.path(), &output).unwrap();
        assert_eq!(fs::read(output.join("new")).unwrap(), b"new");
        assert!(!output.join("old").exists());
    }

    #[test]
    fn failed_swap_restores_original() {
        let parent = tempfile::tempdir().unwrap();
        let output = parent.path().join("site");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("old"), b"old").unwrap();
        assert!(replace_directory(&parent.path().join("missing"), &output).is_err());
        assert_eq!(fs::read(output.join("old")).unwrap(), b"old");
    }

    #[test]
    fn metadata_roundtrip_and_corruption() {
        let root = tempfile::tempdir().unwrap();
        assert!(load_metadata(root.path()).file_cids.is_empty());
        let metadata = Metadata {
            record_cid: "record".into(),
            file_cids: BTreeMap::from([("index.html".into(), "blob".into())]),
            last_sync: 42,
        };
        fs::write(
            root.path().join(METADATA_FILE),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        let loaded = load_metadata(root.path());
        assert_eq!(loaded.record_cid, "record");
        assert_eq!(loaded.file_cids, metadata.file_cids);
        fs::write(root.path().join(METADATA_FILE), b"{bad").unwrap();
        assert!(load_metadata(root.path()).file_cids.is_empty());
    }
}
