//! Bounded SubFS expansion with per-file source repository provenance.
use jacquard_common::types::blob::BlobRef;
use jacquard_lexicon::schema::LexiconSchema;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::future::{Future, poll_fn};
use std::task::Poll;
use wisp_lexicons::place_wisp::{fs, subfs};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubfsSubject {
    pub uri: String,
    pub repo: String,
    pub collection: String,
    pub rkey: String,
}

pub fn parse_subfs_subject(uri: &str) -> Result<SubfsSubject, ExpansionError> {
    let parts: Vec<_> = uri
        .strip_prefix("at://")
        .ok_or(ExpansionError::InvalidSubject)?
        .split('/')
        .collect();
    if parts.len() != 3 || parts[1] != "place.wisp.subfs" {
        return Err(ExpansionError::InvalidSubject);
    }
    let repo = parts[0];
    let rkey = parts[2];
    let (method, identifier) = repo
        .strip_prefix("did:")
        .and_then(|did| did.split_once(':'))
        .ok_or(ExpansionError::InvalidSubject)?;
    let mut identifier_bytes = identifier.bytes();
    let mut valid_identifier = true;
    let mut final_literal = false;
    while let Some(byte) = identifier_bytes.next() {
        if byte == b'%' {
            final_literal = false;
            valid_identifier &= (0..2).all(|_| {
                identifier_bytes
                    .next()
                    .is_some_and(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
            });
        } else {
            valid_identifier &= byte.is_ascii_alphanumeric() || b"._:-".contains(&byte);
            final_literal = byte.is_ascii_alphanumeric() || b"._-".contains(&byte);
        }
    }
    if repo.len() > 2048
        || method.is_empty()
        || !method.bytes().all(|b| b.is_ascii_lowercase())
        || !valid_identifier
        || !final_literal
        || rkey.is_empty()
        || rkey.len() > 512
        || matches!(rkey, "." | "..")
        || !rkey
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_~.:-".contains(&b))
    {
        return Err(ExpansionError::InvalidSubject);
    }
    Ok(SubfsSubject {
        uri: uri.into(),
        repo: repo.into(),
        collection: parts[1].into(),
        rkey: rkey.into(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpansionError {
    Cycle,
    DuplicatePath,
    FetchFailed,
    InvalidLimits,
    InvalidRecord,
    InvalidSubject,
    MaxDepth,
    MaxEntries,
    MaxFiles,
    MaxRecords,
    MaxRawBytes,
    MissingRecord,
}

impl ExpansionError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Cycle => "CYCLE",
            Self::DuplicatePath => "DUPLICATE_PATH",
            Self::FetchFailed => "FETCH_FAILED",
            Self::InvalidLimits => "INVALID_LIMITS",
            Self::InvalidRecord => "INVALID_RECORD",
            Self::InvalidSubject => "INVALID_SUBJECT",
            Self::MaxDepth => "MAX_DEPTH",
            Self::MaxEntries => "MAX_ENTRIES",
            Self::MaxFiles => "MAX_FILES",
            Self::MaxRecords => "MAX_RECORDS",
            Self::MaxRawBytes => "MAX_RAW_BYTES",
            Self::MissingRecord => "MISSING_RECORD",
        }
    }
}
impl fmt::Display for ExpansionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Cycle => "SubFS expansion contains a cycle",
            Self::DuplicatePath => "SubFS expansion contains duplicate output paths",
            Self::FetchFailed => "SubFS record fetch failed",
            Self::InvalidLimits => "SubFS expansion limits are invalid",
            Self::InvalidRecord => "SubFS record is invalid",
            Self::InvalidSubject => "SubFS subject is invalid",
            Self::MaxDepth => "SubFS expansion exceeded its nesting limit",
            Self::MaxEntries => "SubFS expansion exceeded its entry limit",
            Self::MaxFiles => "SubFS expansion exceeded its file limit",
            Self::MaxRecords => "SubFS expansion exceeded its record limit",
            Self::MaxRawBytes => "SubFS expansion exceeded its raw JSON byte limit",
            Self::MissingRecord => "SubFS record is missing",
        })
    }
}
impl std::error::Error for ExpansionError {}

#[derive(Clone, Copy, Debug)]
pub struct ExpansionLimits {
    pub max_concurrent_fetches: usize,
    pub max_depth: usize,
    pub max_entries: usize,
    pub max_files: usize,
    pub max_records: usize,
    pub max_raw_json_bytes: usize,
}
impl Default for ExpansionLimits {
    fn default() -> Self {
        Self {
            max_concurrent_fetches: 4,
            max_depth: 10,
            max_entries: 5_000,
            max_files: 1_000,
            max_records: 100,
            max_raw_json_bytes: 8 * 1024 * 1024,
        }
    }
}
impl ExpansionLimits {
    fn validate(self) -> Result<Self, ExpansionError> {
        if self.max_concurrent_fetches == 0
            || self.max_records == 0
            || self.max_raw_json_bytes == 0
            || [
                self.max_concurrent_fetches,
                self.max_depth,
                self.max_entries,
                self.max_files,
                self.max_records,
                self.max_raw_json_bytes,
            ]
            .iter()
            .any(|&value| value as u128 > 9_007_199_254_740_991)
        {
            return Err(ExpansionError::InvalidLimits);
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct ExpandedSubfs {
    pub root: Value,
    pub owner_did_by_file_path: BTreeMap<String, String>,
}

fn entries(node: &Value) -> Result<&Vec<Value>, ExpansionError> {
    node.get("entries")
        .and_then(Value::as_array)
        .ok_or(ExpansionError::InvalidRecord)
}

fn validate_typed<T>(raw: &Value) -> Result<T, ExpansionError>
where
    T: serde::de::DeserializeOwned + LexiconSchema,
{
    let typed: T =
        serde_json::from_value(raw.clone()).map_err(|_| ExpansionError::InvalidRecord)?;
    typed
        .validate()
        .map_err(|_| ExpansionError::InvalidRecord)?;
    Ok(typed)
}

/// Open unions fall back to unknown variants on malformed known nodes, so each
/// known node needs explicit deserialization plus deferred CID/lexicon checks.
fn validate_directory(node: &Value, namespace: &str, nesting: usize) -> Result<(), ExpansionError> {
    if nesting > 128 || node["type"] != "directory" || entries(node)?.len() > 500 {
        return Err(ExpansionError::InvalidRecord);
    }
    if namespace == "place.wisp.fs" {
        validate_typed::<fs::Directory<String>>(node)?;
    } else {
        validate_typed::<subfs::Directory<String>>(node)?;
    }
    for entry in entries(node)? {
        if namespace == "place.wisp.fs" {
            validate_typed::<fs::Entry<String>>(entry)?;
        } else {
            validate_typed::<subfs::Entry<String>>(entry)?;
        }
        let name = entry["name"]
            .as_str()
            .ok_or(ExpansionError::InvalidRecord)?;
        if name.len() > 255 {
            return Err(ExpansionError::InvalidRecord);
        }
        let child = &entry["node"];
        let tag = child["$type"]
            .as_str()
            .ok_or(ExpansionError::InvalidRecord)?;
        let kind = tag
            .strip_prefix(namespace)
            .and_then(|suffix| suffix.strip_prefix('#'));
        match kind {
            Some("directory") => validate_directory(child, namespace, nesting + 1)?,
            Some("file") => {
                let blob: BlobRef<String> = serde_json::from_value(child["blob"].clone())
                    .map_err(|_| ExpansionError::InvalidRecord)?;
                if !blob.blob().cid().is_valid()
                    || child["type"] != "file"
                    || blob.blob().size > 1_000_000_000
                    || child.get("encoding").is_some_and(|value| value != "gzip")
                    || child.get("base64").is_some_and(|value| !value.is_boolean())
                    || child
                        .get("mimeType")
                        .is_some_and(|value| !value.is_string())
                {
                    return Err(ExpansionError::InvalidRecord);
                }
                if namespace == "place.wisp.fs" {
                    validate_typed::<fs::File<String>>(child)?;
                } else {
                    validate_typed::<subfs::File<String>>(child)?;
                }
            }
            Some("subfs") => {
                if child["type"] != "subfs" {
                    return Err(ExpansionError::InvalidRecord);
                }
                if namespace == "place.wisp.fs" {
                    validate_typed::<fs::Subfs<String>>(child)?;
                } else {
                    validate_typed::<subfs::Subfs<String>>(child)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_record_shape(raw: &Value, namespace: &str) -> Result<(), ExpansionError> {
    if raw["$type"] != namespace
        || raw
            .get("fileCount")
            .is_some_and(|count| count.as_u64().is_none_or(|count| count > 1000))
    {
        return Err(ExpansionError::InvalidRecord);
    }
    validate_directory(&raw["root"], namespace, 0)
}

/// Validate a raw root manifest recursively before trusting its open-union nodes.
pub fn validate_fs_record(raw: &Value) -> Result<(), ExpansionError> {
    validate_record_shape(raw, "place.wisp.fs")?;
    validate_typed::<fs::Fs<String>>(raw)?;
    Ok(())
}

fn validate_record(raw: Value) -> Result<Value, ExpansionError> {
    validate_record_shape(&raw, "place.wisp.subfs")?;
    validate_typed::<subfs::SubfsRecord<String>>(&raw)?;
    Ok(raw)
}

fn convert_entries(children: &[Value], nesting: usize) -> Result<Vec<Value>, ExpansionError> {
    if nesting > 128 {
        return Err(ExpansionError::InvalidRecord);
    }
    children
        .iter()
        .map(|entry| {
            let node = &entry["node"];
            let converted = match node["type"].as_str() {
                Some("directory") if node.get("entries").is_some() => {
                    make_directory(convert_entries(entries(node)?, nesting + 1)?)
                }
                Some("file") if node.get("blob").is_some() => {
                    let mut file = json!({
                        "$type": "place.wisp.fs#file",
                        "type": "file",
                        "blob": node["blob"],
                    });
                    for key in ["encoding", "mimeType", "base64"] {
                        if let Some(value) = node.get(key) {
                            file[key] = value.clone();
                        }
                    }
                    file
                }
                Some("subfs") if node.get("subject").is_some() => json!({
                    "$type": "place.wisp.fs#subfs",
                    "type": "subfs",
                    "subject": node["subject"],
                }),
                _ => node.clone(),
            };
            Ok(json!({
                "$type": "place.wisp.fs#entry",
                "name": entry["name"],
                "node": converted,
            }))
        })
        .collect()
}

fn make_directory(entries: Vec<Value>) -> Value {
    json!({"$type":"place.wisp.fs#directory", "type":"directory", "entries":entries})
}

/// Cleanup callers intentionally extract subjects without validation or fetching.
pub fn extract_subfs_uris(directory: &Value, current_path: &str) -> Vec<(String, String)> {
    let mut output = Vec::new();
    let mut pending: Vec<_> = entries(directory)
        .into_iter()
        .flatten()
        .rev()
        .map(|entry| (entry, current_path.to_owned()))
        .collect();
    while let Some((entry, prefix)) = pending.pop() {
        let path = join_path(&prefix, entry["name"].as_str().unwrap_or(""));
        let node = &entry["node"];
        if node["type"] == "subfs" {
            if let Some(subject) = node["subject"].as_str() {
                output.push((subject.into(), path));
            }
        } else if node["type"] == "directory"
            && let Ok(children) = entries(node)
        {
            pending.extend(children.iter().rev().map(|entry| (entry, path.clone())));
        }
    }
    output
}

fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.into()
    } else {
        format!("{prefix}/{name}")
    }
}

#[derive(Clone, Copy)]
struct Branch<'a> {
    depth: usize,
    subjects: &'a BTreeSet<String>,
    prefix: &'a str,
    owner: &'a str,
    nesting: usize,
}

struct Expansion<F> {
    fetch: F,
    limits: ExpansionLimits,
    records: BTreeMap<String, Value>,
    owners: BTreeMap<String, String>,
    paths: BTreeSet<String>,
    files: usize,
    raw_bytes: usize,
}

impl<F, Fut> Expansion<F>
where
    F: FnMut(SubfsSubject) -> Fut,
    Fut: Future<Output = Result<Option<Value>, ExpansionError>>,
{
    fn count(&mut self, entry: &Value, path: String, owner: &str) -> Result<(), ExpansionError> {
        if !self.paths.insert(path.clone()) {
            return Err(ExpansionError::DuplicatePath);
        }
        if self.paths.len() > self.limits.max_entries {
            return Err(ExpansionError::MaxEntries);
        }
        if entry["node"]["type"] == "file" && entry["node"].get("blob").is_some() {
            self.files += 1;
            if self.files > self.limits.max_files {
                return Err(ExpansionError::MaxFiles);
            }
            self.owners.insert(path, owner.into());
        }
        Ok(())
    }

    fn accept_record(
        &mut self,
        subject: &SubfsSubject,
        raw: Option<Value>,
    ) -> Result<(), ExpansionError> {
        let raw = raw
            .filter(|value| !value.is_null())
            .ok_or(ExpansionError::MissingRecord)?;
        let bytes = serde_json::to_vec(&raw)
            .map_err(|_| ExpansionError::InvalidRecord)?
            .len();
        self.raw_bytes = self
            .raw_bytes
            .checked_add(bytes)
            .ok_or(ExpansionError::MaxRawBytes)?;
        if self.raw_bytes > self.limits.max_raw_json_bytes {
            return Err(ExpansionError::MaxRawBytes);
        }
        self.records
            .insert(subject.uri.clone(), validate_record(raw)?);
        Ok(())
    }

    async fn prefetch(&mut self, subjects: Vec<SubfsSubject>) -> Result<(), ExpansionError> {
        for chunk in subjects.chunks(self.limits.max_concurrent_fetches) {
            if self.records.len() + chunk.len() > self.limits.max_records {
                return Err(ExpansionError::MaxRecords);
            }
            let mut pending: Vec<_> = chunk
                .iter()
                .map(|subject| Some(Box::pin((self.fetch)(subject.clone()))))
                .collect();
            poll_fn(|cx| {
                let mut complete = true;
                for (subject, future) in chunk.iter().zip(&mut pending) {
                    if let Some(work) = future {
                        match work.as_mut().poll(cx) {
                            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                            Poll::Ready(Ok(raw)) => {
                                *future = None;
                                if let Err(error) = self.accept_record(subject, raw) {
                                    return Poll::Ready(Err(error));
                                }
                            }
                            Poll::Pending => complete = false,
                        }
                    }
                }
                if complete {
                    Poll::Ready(Ok(()))
                } else {
                    Poll::Pending
                }
            })
            .await?;
        }
        Ok(())
    }

    async fn expand_entries(
        &mut self,
        children: Vec<Value>,
        context: Branch<'_>,
    ) -> Result<Vec<Value>, ExpansionError> {
        let Branch {
            depth,
            subjects: branch,
            prefix,
            owner,
            nesting,
        } = context;
        if nesting > 128 {
            return Err(ExpansionError::InvalidRecord);
        }
        let mut output = Vec::new();
        for batch in children.chunks(32) {
            // Cooperative yielding lets an outer timeout cancel even fetch-free trees.
            let mut yielded = false;
            poll_fn(|cx| {
                if yielded {
                    Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
            })
            .await;
            let mut subjects = Vec::new();
            let mut seen = BTreeSet::new();
            for entry in batch {
                let node = &entry["node"];
                if node["type"] == "subfs" && node.get("subject").is_some() {
                    if depth >= self.limits.max_depth {
                        return Err(ExpansionError::MaxDepth);
                    }
                    let subject = parse_subfs_subject(
                        node["subject"]
                            .as_str()
                            .ok_or(ExpansionError::InvalidSubject)?,
                    )?;
                    if branch.contains(&subject.uri) {
                        return Err(ExpansionError::Cycle);
                    }
                    if !self.records.contains_key(&subject.uri) && seen.insert(subject.uri.clone())
                    {
                        subjects.push(subject);
                    }
                }
            }
            self.prefetch(subjects).await?;
            for mut entry in batch.iter().cloned() {
                let name = entry["name"]
                    .as_str()
                    .ok_or(ExpansionError::InvalidRecord)?;
                let path = join_path(prefix, name);
                let node = &entry["node"];
                if node["type"] == "subfs" && node.get("subject").is_some() {
                    let subject = parse_subfs_subject(
                        node["subject"]
                            .as_str()
                            .ok_or(ExpansionError::InvalidSubject)?,
                    )?;
                    let record = &self.records[&subject.uri];
                    let nested = convert_entries(entries(&record["root"])?, 0)?;
                    let mut next_branch = branch.clone();
                    next_branch.insert(subject.uri);
                    let mounted = node["flat"] == false;
                    let replacement = Box::pin(self.expand_entries(
                        nested,
                        Branch {
                            depth: depth + 1,
                            subjects: &next_branch,
                            prefix: if mounted { &path } else { prefix },
                            owner: &subject.repo,
                            nesting: nesting + 1,
                        },
                    ))
                    .await?;
                    if mounted {
                        entry["node"] = make_directory(replacement);
                        self.count(&entry, path, owner)?;
                        output.push(entry);
                    } else {
                        output.extend(replacement);
                    }
                } else if node["type"] == "directory" && node.get("entries").is_some() {
                    let children = entries(node)?.clone();
                    let expanded = Box::pin(self.expand_entries(
                        children,
                        Branch {
                            prefix: &path,
                            nesting: nesting + 1,
                            ..context
                        },
                    ))
                    .await?;
                    entry["node"]["entries"] = Value::Array(expanded);
                    self.count(&entry, path, owner)?;
                    output.push(entry);
                } else {
                    self.count(&entry, path, owner)?;
                    output.push(entry);
                }
            }
        }
        Ok(output)
    }
}

/// Fetches raw record values, never XRPC wrappers. Dropping this future cancels
/// all pending callbacks; callers own deadline and transfer-budget enforcement.
pub async fn expand_subfs<F, Fut>(
    mut root: Value,
    root_owner_did: &str,
    limits: ExpansionLimits,
    fetch: F,
) -> Result<ExpandedSubfs, ExpansionError>
where
    F: FnMut(SubfsSubject) -> Fut,
    Fut: Future<Output = Result<Option<Value>, ExpansionError>>,
{
    let mut state = Expansion {
        fetch,
        limits: limits.validate()?,
        records: BTreeMap::new(),
        owners: BTreeMap::new(),
        paths: BTreeSet::new(),
        files: 0,
        raw_bytes: 0,
    };
    let children = entries(&root)?.clone();
    root["entries"] = Value::Array(
        state
            .expand_entries(
                children,
                Branch {
                    depth: 0,
                    subjects: &BTreeSet::new(),
                    prefix: "",
                    owner: root_owner_did,
                    nesting: 0,
                },
            )
            .await?,
    );
    Ok(ExpandedSubfs {
        root,
        owner_did_by_file_path: state.owners,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::pin::pin;
    use std::rc::Rc;
    use std::sync::Arc;
    use std::task::{Context, Wake, Waker};

    struct ThreadWake(std::thread::Thread);
    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    fn block_on<T>(future: impl Future<Output = T>) -> T {
        let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let mut future = pin!(future);
        loop {
            if let Poll::Ready(result) = future.as_mut().poll(&mut cx) {
                return result;
            }
            std::thread::park();
        }
    }
    fn subject(owner: &str, key: &str) -> String {
        format!("at://did:plc:{owner}/place.wisp.subfs/{key}")
    }
    fn file(name: &str, lexicon: &str) -> Value {
        json!({"name":name,"node":{"$type":format!("place.wisp.{lexicon}#file"),"type":"file","blob":{
            "$type":"blob","ref":{"$link":"bafkreie56uer6qjm7mqckb52xtd3mecy77t5axnumzdcnhjzpcwiin6zue"},"mimeType":"text/plain","size":1
        }}})
    }
    fn mount(name: &str, subject: &str, flat: Option<bool>, lexicon: &str) -> Value {
        let mut node =
            json!({"$type":format!("place.wisp.{lexicon}#subfs"),"type":"subfs","subject":subject});
        if let Some(flat) = flat {
            node["flat"] = flat.into();
        }
        json!({"name":name,"node":node})
    }
    fn root(children: Vec<Value>) -> Value {
        json!({"type":"directory","entries":children})
    }
    fn record(children: Vec<Value>) -> Value {
        json!({"$type":"place.wisp.subfs","createdAt":"2026-01-01T00:00:00.000Z","root":root(children)})
    }
    fn expand(
        root: Value,
        records: BTreeMap<String, Value>,
        limits: ExpansionLimits,
    ) -> Result<ExpandedSubfs, ExpansionError> {
        block_on(expand_subfs(root, "did:plc:root", limits, move |subject| {
            std::future::ready(Ok(records.get(&subject.uri).cloned()))
        }))
    }
    fn names(root: &Value) -> Vec<&str> {
        entries(root)
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn only_canonical_did_subjects() {
        let uri = subject("owner", "record-key_1");
        assert_eq!(
            parse_subfs_subject(&uri).unwrap(),
            SubfsSubject {
                uri: uri.clone(),
                repo: "did:plc:owner".into(),
                collection: "place.wisp.subfs".into(),
                rkey: "record-key_1".into()
            }
        );
        for uri in [
            "at://example.com/place.wisp.subfs/record",
            "at://did:plc:x/place.wisp.fs/record",
            "at://did:plc:x/place.wisp.subfs/record?query=1",
            "at://did:plc:x/place.wisp.subfs/record/extra",
            "at://did:plc:x/place.wisp.subfs/%2F",
            "at://did:plc:x/place.wisp.subfs/.",
            "at://did:plc:x/place.wisp.subfs/..",
            "at://did:plc:x/place.wisp.subfs/record#fragment",
            "at://did:PLC:x/place.wisp.subfs/r",
            "at://did:plc:/place.wisp.subfs/r",
            "at://did:plc:x:/place.wisp.subfs/r",
            "at://did:plc:x%2a/place.wisp.subfs/r",
            "at://did:plc:x%2A/place.wisp.subfs/r",
            "at://did:plc:x%XXz/place.wisp.subfs/r",
            "at://did:plc:x/place.wisp.subfs/r\n",
        ] {
            assert_eq!(
                parse_subfs_subject(uri),
                Err(ExpansionError::InvalidSubject),
                "{uri}"
            );
        }
        assert!(parse_subfs_subject("at://did:web:host%3A443/place.wisp.subfs/r").is_ok());
        assert!(parse_subfs_subject(&subject("owner", &"a".repeat(512))).is_ok());
        assert!(parse_subfs_subject(&subject("owner", &"a".repeat(513))).is_err());
        assert!(parse_subfs_subject(&subject(&"a".repeat(2040), "r")).is_ok());
        assert!(parse_subfs_subject(&subject(&"a".repeat(2041), "r")).is_err());
    }

    #[test]
    fn flat_splice_order_provenance_and_metadata() {
        let uri = subject("first", "flat");
        let mut child = file("one.txt", "subfs");
        child["node"]["encoding"] = "gzip".into();
        child["node"]["mimeType"] = "text/plain".into();
        child["node"]["base64"] = true.into();
        let expanded = expand(
            root(vec![
                file("before.txt", "fs"),
                mount("mount", &uri, None, "fs"),
                file("after.txt", "fs"),
            ]),
            BTreeMap::from([(uri, record(vec![child, file("two.txt", "subfs")]))]),
            ExpansionLimits::default(),
        )
        .unwrap();
        assert_eq!(
            names(&expanded.root),
            ["before.txt", "one.txt", "two.txt", "after.txt"]
        );
        assert_eq!(
            expanded.owner_did_by_file_path,
            BTreeMap::from([
                ("before.txt".into(), "did:plc:root".into()),
                ("one.txt".into(), "did:plc:first".into()),
                ("two.txt".into(), "did:plc:first".into()),
                ("after.txt".into(), "did:plc:root".into())
            ])
        );
        let node = &expanded.root["entries"][1]["node"];
        assert_eq!(node["$type"], "place.wisp.fs#file");
        assert_eq!(node["encoding"], "gzip");
        assert_eq!(node["mimeType"], "text/plain");
        assert_eq!(node["base64"], true);
    }

    #[test]
    fn mounted_nested_cross_repository_tree() {
        let first = subject("first", "first");
        let second = subject("second", "second");
        // Nested flat fields are ignored even if supplied as extension data.
        let nested = mount("nested", &second, Some(false), "subfs");
        let expanded = expand(
            root(vec![
                file("before.txt", "fs"),
                mount("assets", &first, Some(false), "fs"),
                file("after.txt", "fs"),
            ]),
            BTreeMap::from([
                (first, record(vec![nested])),
                (second, record(vec![file("logo.txt", "subfs")])),
            ]),
            ExpansionLimits::default(),
        )
        .unwrap();
        assert_eq!(names(&expanded.root), ["before.txt", "assets", "after.txt"]);
        let mounted = &expanded.root["entries"][1]["node"];
        assert_eq!(mounted["type"], "directory");
        assert_eq!(names(mounted), ["logo.txt"]);
        assert_eq!(
            expanded.owner_did_by_file_path["assets/logo.txt"],
            "did:plc:second"
        );
    }

    #[test]
    fn duplicate_subjects_share_one_fetch_not_one_expansion() {
        let uri = subject("owner", "duplicate");
        let count = Cell::new(0);
        let expanded = block_on(expand_subfs(
            root(vec![
                mount("flat", &uri, None, "fs"),
                mount("folder", &uri, Some(false), "fs"),
            ]),
            "did:plc:root",
            ExpansionLimits::default(),
            |_| {
                count.set(count.get() + 1);
                std::future::ready(Ok(Some(record(vec![file("child.txt", "subfs")]))))
            },
        ))
        .unwrap();
        assert_eq!(count.get(), 1);
        assert_eq!(
            expanded.owner_did_by_file_path["child.txt"],
            "did:plc:owner"
        );
        assert_eq!(
            expanded.owner_did_by_file_path["folder/child.txt"],
            "did:plc:owner"
        );
    }

    #[test]
    fn cycles_and_collisions_fail_closed() {
        let first = subject("owner", "cycle-a");
        let second = subject("owner", "cycle-b");
        let records = BTreeMap::from([
            (
                first.clone(),
                record(vec![mount("b", &second, None, "subfs")]),
            ),
            (second, record(vec![mount("a", &first, None, "subfs")])),
        ]);
        assert_eq!(
            expand(
                root(vec![mount("a", &first, None, "fs")]),
                records,
                ExpansionLimits::default()
            )
            .unwrap_err(),
            ExpansionError::Cycle
        );
        assert_eq!(
            expand(
                root(vec![file("same.txt", "fs"), mount("a", &first, None, "fs")]),
                BTreeMap::from([(first, record(vec![file("same.txt", "subfs")]))]),
                ExpansionLimits::default()
            )
            .unwrap_err(),
            ExpansionError::DuplicatePath
        );
        assert_eq!(
            expand(
                root(vec![
                    json!({"name":"same","node":root(vec![])}),
                    file("same", "fs")
                ]),
                BTreeMap::new(),
                ExpansionLimits::default()
            )
            .unwrap_err(),
            ExpansionError::DuplicatePath
        );
    }

    #[test]
    fn depth_record_entry_file_and_raw_budgets() {
        let first = subject("owner", "budget-a");
        let second = subject("owner", "budget-b");
        let records = BTreeMap::from([
            (
                first.clone(),
                record(vec![mount("second", &second, None, "subfs")]),
            ),
            (
                second.clone(),
                record(vec![file("one.txt", "subfs"), file("two.txt", "subfs")]),
            ),
        ]);
        for (limits, error) in [
            (
                ExpansionLimits {
                    max_depth: 1,
                    ..ExpansionLimits::default()
                },
                ExpansionError::MaxDepth,
            ),
            (
                ExpansionLimits {
                    max_records: 1,
                    ..ExpansionLimits::default()
                },
                ExpansionError::MaxRecords,
            ),
            (
                ExpansionLimits {
                    max_entries: 1,
                    ..ExpansionLimits::default()
                },
                ExpansionError::MaxEntries,
            ),
            (
                ExpansionLimits {
                    max_files: 1,
                    ..ExpansionLimits::default()
                },
                ExpansionError::MaxFiles,
            ),
            (
                ExpansionLimits {
                    max_raw_json_bytes: 1,
                    ..ExpansionLimits::default()
                },
                ExpansionError::MaxRawBytes,
            ),
        ] {
            assert_eq!(
                expand(
                    root(vec![mount("first", &first, None, "fs")]),
                    records.clone(),
                    limits
                )
                .unwrap_err(),
                error
            );
        }
        let bytes = serde_json::to_vec(&records[&first]).unwrap().len();
        assert_eq!(
            expand(
                root(vec![mount("first", &first, None, "fs")]),
                records,
                ExpansionLimits {
                    max_raw_json_bytes: bytes,
                    ..ExpansionLimits::default()
                }
            )
            .unwrap_err(),
            ExpansionError::MaxRawBytes
        );
        assert!(
            expand(
                root(vec![]),
                BTreeMap::new(),
                ExpansionLimits {
                    max_depth: 0,
                    max_entries: 0,
                    max_files: 0,
                    ..ExpansionLimits::default()
                }
            )
            .is_ok()
        );
        assert_eq!(
            expand(
                root(vec![mount("a", &first, None, "fs")]),
                BTreeMap::new(),
                ExpansionLimits {
                    max_depth: 0,
                    ..ExpansionLimits::default()
                }
            )
            .unwrap_err(),
            ExpansionError::MaxDepth
        );
    }

    #[test]
    fn invalid_limits_missing_invalid_subject_and_fetch_errors() {
        for limits in [
            ExpansionLimits {
                max_concurrent_fetches: 0,
                ..ExpansionLimits::default()
            },
            ExpansionLimits {
                max_records: 0,
                ..ExpansionLimits::default()
            },
            ExpansionLimits {
                max_raw_json_bytes: 0,
                ..ExpansionLimits::default()
            },
            ExpansionLimits {
                max_files: usize::MAX,
                ..ExpansionLimits::default()
            },
        ] {
            assert_eq!(
                expand(root(vec![]), BTreeMap::new(), limits).unwrap_err(),
                ExpansionError::InvalidLimits
            );
        }
        let uri = subject("owner", "missing");
        assert_eq!(
            expand(
                root(vec![mount(
                    "a",
                    "at://not-a-did/place.wisp.subfs/r",
                    None,
                    "fs"
                )]),
                BTreeMap::new(),
                ExpansionLimits::default()
            )
            .unwrap_err(),
            ExpansionError::InvalidSubject
        );
        assert_eq!(
            expand(
                root(vec![mount("a", &uri, None, "fs")]),
                BTreeMap::new(),
                ExpansionLimits::default()
            )
            .unwrap_err(),
            ExpansionError::MissingRecord
        );
        let error = block_on(expand_subfs(
            root(vec![mount("a", &uri, None, "fs")]),
            "root",
            ExpansionLimits::default(),
            |_| std::future::ready(Err(ExpansionError::FetchFailed)),
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), "SubFS record fetch failed");
        assert_eq!(error.code(), "FETCH_FAILED");
    }

    #[test]
    fn directory_depth_does_not_spend_subfs_budget_but_is_stack_bounded() {
        let directory = json!({"name": "assets", "node": root(vec![file("index.html", "fs")])});
        assert!(
            expand(
                root(vec![directory]),
                BTreeMap::new(),
                ExpansionLimits {
                    max_depth: 0,
                    ..ExpansionLimits::default()
                }
            )
            .is_ok()
        );
        let mut nested = root(vec![]);
        for _ in 0..130 {
            nested = root(vec![json!({"name": "nested", "node": nested})]);
        }
        assert_eq!(
            expand(nested, BTreeMap::new(), ExpansionLimits::default()).unwrap_err(),
            ExpansionError::InvalidRecord
        );
    }

    #[test]
    fn raw_records_are_recursively_validated() {
        let uri = subject("owner", "malformed");
        let mut malformed = vec![json!({"$type":"place.wisp.subfs","root":{"type":"directory"}})];
        for (path, value) in [
            ("/createdAt", json!("invalid")),
            ("/fileCount", json!(-1)),
            ("/fileCount", json!(1001)),
            ("/root/type", json!("file")),
            ("/root/entries/0/node/type", json!("directory")),
            ("/root/entries/0/node/blob/size", json!(1_000_000_001)),
            ("/root/entries/0/node/blob/size", json!(-1)),
            ("/root/entries/0/node/encoding", json!("br")),
            ("/root/entries/0/node/base64", json!("true")),
            ("/root/entries/0/node/blob/ref/$link", json!("not-a-cid")),
            ("/root/entries/0/name", json!("x".repeat(256))),
        ] {
            let mut raw = record(vec![file("test", "subfs")]);
            // Optional encoding/base64 keys need to exist before pointer mutation.
            raw["root"]["entries"][0]["node"]["encoding"] = "gzip".into();
            raw["root"]["entries"][0]["node"]["base64"] = false.into();
            raw["fileCount"] = 1.into();
            *raw.pointer_mut(path).unwrap() = value;
            malformed.push(raw);
        }
        malformed.push(record(vec![file("test", "subfs"); 501]));
        for raw in malformed {
            assert_eq!(
                expand(
                    root(vec![mount("a", &uri, None, "fs")]),
                    BTreeMap::from([(uri.clone(), raw.clone())]),
                    ExpansionLimits::default()
                )
                .unwrap_err(),
                ExpansionError::InvalidRecord,
                "{raw}"
            );
        }
    }

    #[test]
    fn root_fs_validation_rejects_malformed_known_unions() {
        let uri = subject("owner", "child");
        let manifest = json!({"$type":"place.wisp.fs", "site":"example",
            "createdAt":"2026-01-01T00:00:00.000Z", "fileCount":1,
            "root":root(vec![file("index.html", "fs"), mount("child", &uri, Some(false), "fs")])});
        assert!(validate_fs_record(&manifest).is_ok());
        for (path, value) in [
            ("/$type", json!("place.wisp.subfs")),
            ("/site", json!(1)),
            ("/createdAt", json!("invalid")),
            ("/fileCount", json!(1001)),
            ("/root/type", json!("file")),
            ("/root/entries", json!(false)),
            ("/root/entries/0/name", json!("x".repeat(256))),
            ("/root/entries/0/node/type", json!("directory")),
            ("/root/entries/0/node/blob/ref/$link", json!("not-a-cid")),
            ("/root/entries/0/node/blob/size", json!(1_000_000_001)),
            ("/root/entries/1/node/flat", json!("false")),
            ("/root/entries/1/node/subject", json!("not-an-at-uri")),
            ("/root/entries/1/node/type", json!("file")),
        ] {
            let mut raw = manifest.clone();
            *raw.pointer_mut(path).unwrap() = value;
            assert_eq!(
                validate_fs_record(&raw),
                Err(ExpansionError::InvalidRecord),
                "{raw}"
            );
        }
        for (key, value) in [
            ("encoding", json!("br")),
            ("base64", json!("true")),
            ("mimeType", json!(5)),
        ] {
            let mut raw = manifest.clone();
            raw["root"]["entries"][0]["node"][key] = value;
            assert_eq!(validate_fs_record(&raw), Err(ExpansionError::InvalidRecord));
        }
        let mut raw = manifest.clone();
        raw["root"] = root(vec![json!({"name":"folder","node":{
            "$type":"place.wisp.fs#directory", "type":"directory", "entries":[file("child", "fs")]
        }})]);
        assert!(validate_fs_record(&raw).is_ok());
        raw["root"]["entries"][0]["node"]["entries"][0]["node"]["blob"]["size"] = (-1).into();
        assert_eq!(validate_fs_record(&raw), Err(ExpansionError::InvalidRecord));
        raw["root"] = root(vec![
            json!({"name":"future","node":{"$type":"place.wisp.future","value":42}}),
        ]);
        assert!(validate_fs_record(&raw).is_ok());
    }

    #[test]
    fn concurrent_fetches_reach_but_never_exceed_cap() {
        let active = Rc::new(Cell::new(0));
        let max_active = Rc::new(Cell::new(0));
        let children = (0..6)
            .map(|i| {
                mount(
                    &format!("mount{i}"),
                    &subject("owner", &format!("parallel{i}")),
                    None,
                    "fs",
                )
            })
            .collect();
        let expanded = block_on(expand_subfs(
            root(children),
            "root",
            ExpansionLimits {
                max_concurrent_fetches: 2,
                ..ExpansionLimits::default()
            },
            |subject| {
                active.set(active.get() + 1);
                max_active.set(max_active.get().max(active.get()));
                let active = active.clone();
                async move {
                    let mut yielded = false;
                    poll_fn(|cx| {
                        if yielded {
                            Poll::Ready(())
                        } else {
                            yielded = true;
                            cx.waker().wake_by_ref();
                            Poll::Pending
                        }
                    })
                    .await;
                    active.set(active.get() - 1);
                    Ok(Some(record(vec![file(&subject.rkey, "subfs")])))
                }
            },
        ))
        .unwrap();
        assert_eq!(max_active.get(), 2);
        assert_eq!(active.get(), 0);
        assert_eq!(expanded.owner_did_by_file_path.len(), 6);
    }

    #[test]
    fn missing_record_fails_without_waiting_for_stalled_sibling() {
        let children = vec![
            mount("first", &subject("owner", "first"), None, "fs"),
            mount("stalled", &subject("owner", "stalled"), None, "fs"),
        ];
        let pending = expand_subfs(
            root(children),
            "root",
            ExpansionLimits::default(),
            |subject| {
                poll_fn(move |_| {
                    if subject.rkey == "first" {
                        Poll::Ready(Ok(None))
                    } else {
                        Poll::Pending
                    }
                })
            },
        );
        let mut pending = pin!(pending);
        let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
        let mut context = Context::from_waker(&waker);
        assert!(pending.as_mut().poll(&mut context).is_pending());
        assert!(matches!(
            pending.as_mut().poll(&mut context),
            Poll::Ready(Err(ExpansionError::MissingRecord))
        ));
    }

    #[test]
    fn pending_tree_yields_and_can_be_cancelled_before_fetch() {
        let fetches = Cell::new(0);
        let children = (0..64).map(|i| file(&format!("file{i}"), "fs")).collect();
        let pending = expand_subfs(root(children), "root", ExpansionLimits::default(), |_| {
            fetches.set(fetches.get() + 1);
            std::future::ready(Ok(None))
        });
        let mut pending = Box::pin(pending);
        let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
        assert!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        drop(pending);
        assert_eq!(fetches.get(), 0);
    }

    #[test]
    fn unknown_union_preserved_and_cleanup_order_is_depth_first() {
        let unknown = json!({"name":"future","node":{"$type":"place.wisp.future","value":42}});
        let expanded = expand(
            root(vec![unknown.clone()]),
            BTreeMap::new(),
            ExpansionLimits::default(),
        )
        .unwrap();
        assert_eq!(expanded.root["entries"][0], unknown);
        assert!(expanded.owner_did_by_file_path.is_empty());
        let directory = root(vec![
            json!({"name":"a","node":root(vec![mount("x","unvalidated-x",None,"fs")])}),
            json!({"name":"b","node":root(vec![mount("y","unvalidated-y",None,"fs")])}),
            mount("z", "unvalidated-z", None, "fs"),
        ]);
        assert_eq!(
            extract_subfs_uris(&directory, "base"),
            vec![
                ("unvalidated-x".into(), "base/a/x".into()),
                ("unvalidated-y".into(), "base/b/y".into()),
                ("unvalidated-z".into(), "base/z".into())
            ]
        );
    }
}
