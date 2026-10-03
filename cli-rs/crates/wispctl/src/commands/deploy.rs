//! Deployment orchestrates repository effects around the pure tree/split planner.

use crate::deploy::{repo, repo::SiteRepo, upload};
use crate::{
    auth::{self, AuthOptions},
    cli::DeployArgs,
    prompts,
    xrpc::{self, bind_auth_status, items},
};
use anyhow::{Result, bail};
use jacquard::types::{string::Datetime, tid::Tid};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use wispplace_core::{
    blob::{is_text_mime, mime_for, should_compress},
    constants::{MAX_FILE_COUNT, MAX_FILE_SIZE, MAX_SITE_SIZE},
    convert::subfs_to_fs,
    ignore::collect_files,
    split::{manifest, split_plan, subfs_record},
    tree::{ExistingBlob, UploadResult, build_tree, extract_blob_map, extract_subfs_uris},
};
use wispplace_lexicons::place_wisp::{
    fs::Fs,
    settings::{CustomHeader, Settings},
    subfs::SubfsRecord,
    v2::domain,
};
use wispplace_ui::{TextPrompt, s};

/// Mirrors the `place.wisp.settings` limits the hosting service enforces.
const MAX_HEADERS: usize = 50;
const MAX_HEADER_NAME: usize = 100;
const MAX_HEADER_VALUE: usize = 1_000;

/// One `--header "Name: value"`: an RFC 9110 token name, and a value free of
/// control characters (tabs aside) so it cannot split the response.
pub fn parse_header(raw: &str) -> Result<(String, String), String> {
    let (name, value) = raw.split_once(':').ok_or("expected \"Name: value\"")?;
    let (name, value) = (name.trim(), value.trim());
    let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
    if name.is_empty() || name.len() > MAX_HEADER_NAME || !name.chars().all(token) {
        return Err(format!(
            "invalid header name \"{name}\": use 1-{MAX_HEADER_NAME} token characters"
        ));
    }
    if value.len() > MAX_HEADER_VALUE || value.chars().any(|c| c.is_control() && c != '\t') {
        return Err(format!(
            "invalid value for {name}: at most {MAX_HEADER_VALUE} characters, no control characters"
        ));
    }
    Ok((name.to_owned(), value.to_owned()))
}

/// The settings record a deploy writes, or `None` when nothing was asked for.
fn site_settings(directory: bool, spa: bool, headers: &[(String, String)]) -> Option<Settings> {
    if !directory && !spa && headers.is_empty() {
        return None;
    }
    Some(Settings {
        directory_listing: Some(directory),
        clean_urls: Some(true),
        spa_mode: spa.then(|| "index.html".into()),
        custom404: None,
        headers: (!headers.is_empty()).then(|| {
            headers
                .iter()
                .map(|(name, value)| CustomHeader {
                    name: name.as_str().into(),
                    path: None,
                    value: value.as_str().into(),
                    extra_data: None,
                })
                .collect()
        }),
        index_files: None,
        extra_data: None,
    })
}

/// Normalize and validate a preview host supplied by a user or environment.
pub fn normalize_preview_host(host: &str) -> Result<String> {
    let host = host.to_ascii_lowercase();
    if host.is_empty()
        || host.chars().any(char::is_whitespace)
        || host.contains('/')
        || host.contains(':')
        || host.contains('?')
        || host.contains('#')
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').any(|label| {
            label.is_empty()
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        bail!("preview host must be a plain hostname");
    }
    Ok(host)
}

/// Whether `site` is `pr-` plus the seven lowercase hex characters of a commit.
fn is_preview_site(site: &str) -> bool {
    site.len() == 10
        && site.starts_with("pr-")
        && site[3..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The claimed wisp subdomain labels in a `domain.getList` response, whatever base host serves them.
fn wisp_claims(domains: &[serde_json::Value]) -> Vec<String> {
    domains
        .iter()
        .filter(|item| item["kind"].as_str() == Some("wisp"))
        .filter_map(|item| item["domain"].as_str()?.split('.').next())
        .map(str::to_owned)
        .collect()
}

/// Build the canonical host used by hosting-service preview routing.
pub fn build_preview_url(site: &str, claim: &str, host: &str) -> Result<String> {
    if !is_preview_site(site) {
        bail!("--preview-host needs a site named pr-<sha7>");
    }
    if claim.is_empty()
        || !claim
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || claim.starts_with('-')
        || claim.ends_with('-')
        || claim.contains("--")
    {
        bail!("preview claim must match [a-z0-9]+(-[a-z0-9]+)*");
    }
    let host = normalize_preview_host(host)?;
    let label = format!("{site}-{claim}");
    if label.len() > 63 {
        bail!("preview host label is longer than 63 characters");
    }
    Ok(format!("https://{label}.{host}/"))
}

fn valid_site(site: &str) -> bool {
    !site.is_empty()
        && site.len() <= 512
        && site
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._~:-".contains(&c))
}

pub async fn run(mut args: DeployArgs) -> Result<()> {
    let known = if args.handle.is_none() && args.password.is_none() {
        auth::resolve_account_for_cwd(args.db.db.as_deref()).await
    } else {
        None
    };
    let needs_handle = args.handle.is_none() && known.is_none();
    let prompted = needs_handle || args.path.is_none() || args.site.is_none();
    if prompted {
        wispplace_ui::intro("deploy");
    }
    if needs_handle {
        args.handle = Some(prompts::handle("Deploy cancelled")?);
    }
    let path = match args.path {
        Some(path) => path,
        None => prompts::required_text(
            TextPrompt::new("Directory to deploy")
                .placeholder(".")
                .default("."),
            "Deploy cancelled",
            "Missing path: pass --path <path>",
        )?
        .into(),
    };
    let site = match args.site {
        Some(site) => site,
        None => prompts::required_text(
            TextPrompt::new("Site name")
                .placeholder("my-website")
                .validate(|value| {
                    if value.is_empty() {
                        Err("Site name is required".into())
                    } else if !valid_site(value) {
                        Err("Site name must be 1-512 characters of [a-zA-Z0-9._~:-]".into())
                    } else {
                        Ok(())
                    }
                }),
            "Deploy cancelled",
            "Missing site name: pass --site <name>",
        )?,
    }
    .to_lowercase();
    if !valid_site(&site) {
        bail!("Invalid site name: {site}. Must be 1-512 chars of [a-zA-Z0-9._~:-]");
    }
    let preview_host = args
        .preview_host
        .as_deref()
        .map(normalize_preview_host)
        .transpose()?;
    if preview_host.is_some() && !is_preview_site(&site) {
        bail!("--preview-host needs a site named pr-<sha7>");
    }
    if args.concurrency == 0 {
        bail!("Concurrency must be at least 1");
    }
    if args.headers.len() > MAX_HEADERS {
        bail!("At most {MAX_HEADERS} --header values are allowed");
    }
    let mut spinner = wispplace_ui::spinner("Authenticating...");
    let authenticated = auth::authenticate(
        args.handle.as_deref(),
        &AuthOptions {
            app_password: args.password,
            db_path: args.db.db,
            force_reauth: false,
        },
        |message| bind_auth_status(&mut spinner, message),
    )
    .await?;
    spinner.succeed(format!("Authenticated as {}", authenticated.did));
    let agent = authenticated.agent;
    let did = authenticated.did;
    let preview_url = if let Some(host) = preview_host.as_deref() {
        let claim = match args.preview_claim.as_deref() {
            Some(claim) => claim.to_owned(),
            None => {
                let service = xrpc::parse_service_did(args.service.as_deref())?;
                let data = xrpc::send(&agent, &service, domain::get_list::GetList, None).await?;
                let claims = wisp_claims(items(&data, "domains"));
                match claims.as_slice() {
                    [] => bail!("no wisp subdomain claimed; claim one or pass --preview-claim"),
                    [claim] => claim.clone(),
                    claims => bail!(
                        "multiple wisp subdomains claimed ({}); pass --preview-claim",
                        claims.join(", ")
                    ),
                }
            }
        };
        Some(build_preview_url(&site, &claim, host)?)
    } else {
        None
    };
    wispplace_ui::blank();
    wispplace_ui::note(wispplace_ui::Line::from(vec![
        s::accent("Deploying "),
        s::bold(site.clone()),
        s::accent(format!(" from {}", path.display())),
    ]));
    wispplace_ui::blank();
    let spinner = wispplace_ui::spinner("Scanning directory...");
    let files = collect_files(&path)?;
    if files.is_empty() {
        spinner.fail("No files found to deploy".to_owned());
        bail!("No files found");
    }
    let size: u64 = files.iter().map(|file| file.size).sum();
    spinner.succeed(format!(
        "Found {} files ({})",
        files.len(),
        wispplace_ui::format_bytes(size)
    ));
    if files.len() > MAX_FILE_COUNT {
        wispplace_ui::warning(format!(
            "Warning: Site has {} files (limit: {MAX_FILE_COUNT})",
            files.len()
        ));
        wispplace_ui::warning("Site may not be cached by the hosting service.");
    }
    if size > MAX_SITE_SIZE {
        wispplace_ui::warning(format!(
            "Warning: Site is {} (limit: {})",
            wispplace_ui::format_bytes(size),
            wispplace_ui::format_bytes(MAX_SITE_SIZE)
        ));
        wispplace_ui::warning("Site may not be cached by the hosting service.");
    }
    for file in files.iter().filter(|file| file.size > MAX_FILE_SIZE) {
        wispplace_ui::warning(format!(
            "Warning: {} exceeds max size ({} > {})",
            file.relative_path,
            wispplace_ui::format_bytes(file.size),
            wispplace_ui::format_bytes(MAX_FILE_SIZE)
        ));
        wispplace_ui::warning("This file may not be cached by the hosting service.");
    }
    let spinner = wispplace_ui::spinner("Checking for existing site...");
    let existing = fetch_existing(&agent, &did, &site).await;
    spinner.succeed(
        if existing.is_some() {
            "Found existing site, will reuse unchanged files"
        } else {
            "No existing site found, uploading all files"
        }
        .to_owned(),
    );
    let empty = BTreeMap::new();
    let blobs = existing.as_ref().map(|site| &site.blobs).unwrap_or(&empty);
    let mut uploads = upload::process(
        &agent,
        &files,
        blobs,
        args.concurrency,
        false,
        args.force_gzip,
    )
    .await?;
    let spinner = wispplace_ui::spinner("Creating manifest...");
    // Every subfs record any attempt wrote, so a retried attempt's leftovers
    // are cleaned up with the old site's.
    let mut written = BTreeSet::new();
    let writes = match put_manifest(&agent, &did, &site, &uploads, &mut written).await {
        Ok(writes) => writes,
        Err(error) if repo::http_status(&error) == Some(500) => {
            wispplace_ui::warning(
                "[Deploy] Manifest put failed with 500, retrying with base64 encoding for text files...",
            );
            let text_files: Vec<_> = files
                .iter()
                .filter(|file| {
                    let mime = mime_for(&file.relative_path);
                    should_compress(&mime, &file.relative_path) && is_text_mime(&mime)
                })
                .cloned()
                .collect();
            let replacements: BTreeMap<_, _> = upload::process(
                &agent,
                &text_files,
                blobs,
                args.concurrency,
                true,
                args.force_gzip,
            )
            .await?
            .into_iter()
            .collect();
            for (path, upload) in &mut uploads {
                if let Some(replacement) = replacements.get(path) {
                    *upload = replacement.clone();
                }
            }
            put_manifest(&agent, &did, &site, &uploads, &mut written).await?
        }
        Err(error) => return Err(error),
    };
    spinner.succeed("Created manifest record".to_owned());
    let previous = existing.into_iter().flat_map(|site| site.subfs);
    for key in previous.chain(written).collect::<BTreeSet<_>>() {
        if !writes.contains(&key) {
            // Best effort, like the old CLI: a leftover record is harmless.
            let _ = agent.delete::<SubfsRecord>(&key).await;
        }
    }
    if let Some(settings) = site_settings(args.directory, args.spa, &args.headers) {
        let spinner = wispplace_ui::spinner("Creating settings...");
        agent.put(&site, settings).await?;
        spinner.succeed("Created settings record".to_owned());
    }
    wispplace_ui::blank();
    if let Some(url) = preview_url {
        wispplace_ui::out(labelled("Preview URL", s::link(url)));
    }
    wispplace_ui::out(labelled(
        "URI",
        s::muted(format!("at://{did}/place.wisp.fs/{site}")),
    ));
    if let Some(handle) = args
        .handle
        .or_else(|| known.and_then(|account| account.handle))
    {
        wispplace_ui::out(labelled(
            "URL",
            s::link(format!("https://sites.wisp.place/{handle}/{site}")),
        ));
    }
    wispplace_ui::out(labelled(
        "URL",
        s::link(format!("https://sites.wisp.place/{did}/{site}")),
    ));
    if prompted {
        wispplace_ui::outro("Deployed successfully!");
    } else {
        wispplace_ui::blank();
        wispplace_ui::success("Deployed successfully!");
    }
    Ok(())
}

async fn put_manifest(
    repo: &impl SiteRepo,
    did: &str,
    site: &str,
    uploads: &[(String, UploadResult)],
    written: &mut BTreeSet<String>,
) -> Result<BTreeSet<String>> {
    let root = build_tree(uploads);
    // Millisecond precision, like JavaScript's toISOString in the old CLI.
    let created_at: Datetime = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
        .parse()?;
    let generation = Tid::now_0().to_string();
    let plan = split_plan(&root, did, site, &generation, &created_at)?;
    let splitting = (!plan.records.is_empty())
        .then(|| wispplace_ui::spinner("Splitting large site into subfs records..."));
    let mut completed_messages = Vec::new();
    for message in plan.messages {
        if matches!(
            message,
            wispplace_core::split::SplitMessage::CreatedParent { .. }
        ) {
            completed_messages.push(message);
        } else {
            wispplace_ui::note(s::muted(split_message(message)));
        }
    }
    let mut keys = BTreeSet::new();
    for record in plan.records {
        repo.put(&record.rkey, subfs_record(&record, &created_at))
            .await?;
        written.insert(record.rkey.clone());
        keys.insert(record.rkey);
    }
    for message in completed_messages {
        wispplace_ui::note(s::muted(split_message(message)));
    }
    if let Some(spinner) = splitting {
        spinner.succeed(format!("Created {} subfs records", keys.len()));
    }
    repo.put(site, manifest(site, &plan.directory, &created_at))
        .await?;
    Ok(keys)
}

fn split_message(message: wispplace_core::split::SplitMessage) -> String {
    use wispplace_core::split::SplitMessage;
    match message {
        SplitMessage::DirectoryTooLarge { size } => format!(
            "    → Directory too large ({}), splitting into chunks...",
            wispplace_ui::format_bytes(size as u64)
        ),
        SplitMessage::CreatedChunks { count } => format!("    → Created {count} chunks"),
        SplitMessage::UploadingChunk {
            index,
            count,
            files,
            size,
        } => format!(
            "    → Uploading chunk {index}/{count} ({files} files, {})...",
            wispplace_ui::format_bytes(size as u64)
        ),
        SplitMessage::CreatingParent { count } => {
            format!("    → Creating parent subfs with {count} chunk references...")
        }
        SplitMessage::CreatedParent { count } => {
            format!("    ✓ Created parent subfs with {count} chunks")
        }
        SplitMessage::CannotSplit { files, size } => format!(
            "Cannot split further — no files or directories available ({files} files, {:.1}KB)",
            size as f64 / 1024.0
        ),
    }
}

pub(crate) struct ExistingSite {
    blobs: BTreeMap<String, ExistingBlob>,
    /// Keys of this repo's subfs records the site references.
    pub(crate) subfs: BTreeSet<String>,
}

pub(crate) async fn fetch_existing(
    repo: &impl SiteRepo,
    did: &str,
    site: &str,
) -> Option<ExistingSite> {
    let root = repo.fetch::<Fs>(did, site).await.ok()?.root;
    let mut result = ExistingSite {
        blobs: extract_blob_map(&root),
        subfs: BTreeSet::new(),
    };
    let mut queue = VecDeque::from([(String::new(), root, BTreeSet::new())]);
    let mut visited = BTreeSet::new();
    while let Some((prefix, root, ancestors)) = queue.pop_front() {
        if ancestors.len() >= 100 || visited.len() >= 10_000 {
            continue;
        }
        for reference in extract_subfs_uris(&root) {
            let uri = reference.uri;
            if ancestors.contains(&uri) {
                continue;
            }
            let Ok(subject) = wispplace_core::subfs::parse_subfs_subject(&uri) else {
                continue;
            };
            // Like the TS CLI, only follow (and later clean up) our own records:
            // another repo's blobs cannot be referenced from this one.
            if subject.repo != did {
                continue;
            }
            let key = subject.rkey;
            result.subfs.insert(key.clone());
            let base = if reference.flat {
                reference
                    .path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent)
                    .unwrap_or("")
            } else {
                &reference.path
            };
            let prefix = join(&prefix, base);
            if !visited.insert((prefix.clone(), uri.clone())) {
                continue;
            }
            let Ok(record) = repo.fetch::<SubfsRecord>(did, &key).await else {
                continue;
            };
            let root = subfs_to_fs(&record.root);
            for (path, blob) in extract_blob_map(&root) {
                result.blobs.insert(join(&prefix, &path), blob);
            }
            let mut ancestors = ancestors.clone();
            ancestors.insert(uri);
            queue.push_back((prefix, root, ancestors));
        }
    }
    Some(result)
}

fn join(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        path.into()
    } else if path.is_empty() {
        prefix.into()
    } else {
        format!("{prefix}/{path}")
    }
}

/// `  URL: <value>`: a muted label so only the value itself is highlighted.
fn labelled(label: &str, value: wispplace_ui::Span<'static>) -> wispplace_ui::Line<'static> {
    wispplace_ui::Line::from(vec![s::muted(format!("  {label}: ")), value])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rkeys_match_typescript() {
        for key in ["a", "A._~:-9", &"x".repeat(512)] {
            assert!(valid_site(key));
        }
        for key in ["", "a/b", "a b", "é", &"x".repeat(513)] {
            assert!(!valid_site(key));
        }
    }

    #[test]
    fn parses_headers() {
        assert_eq!(
            parse_header("X-Robots-Tag: noindex, nofollow"),
            Ok(("X-Robots-Tag".into(), "noindex, nofollow".into()))
        );
        assert_eq!(
            parse_header("Link:<https://a.example>; rel=x"),
            Ok(("Link".into(), "<https://a.example>; rel=x".into()))
        );
        for bad in ["noindex", ": v", "Bad Name: v", "X: a\r\nSet-Cookie: b"] {
            assert!(parse_header(bad).is_err(), "{bad}");
        }
        assert!(parse_header(&format!("X: {}", "v".repeat(1_001))).is_err());
    }

    #[test]
    fn settings_only_when_requested() {
        assert_eq!(site_settings(false, false, &[]), None);
        let headers = [("X-Robots-Tag".to_owned(), "noindex".to_owned())];
        let settings = site_settings(false, false, &headers).expect("headers imply settings");
        assert_eq!(settings.directory_listing, Some(false));
        assert_eq!(settings.clean_urls, Some(true));
        let written = settings.headers.expect("headers");
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].name.as_ref() as &str, "X-Robots-Tag");
        assert_eq!(written[0].value.as_ref() as &str, "noindex");
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;

    #[test]
    fn preview_urls_validate_and_normalize() {
        assert_eq!(
            build_preview_url("pr-abcdef0", "alice", "WispSites.Dev").unwrap(),
            "https://pr-abcdef0-alice.wispsites.dev/"
        );
        assert_eq!(
            build_preview_url("pr-ABCDEF0", "alice", "example.com")
                .unwrap_err()
                .to_string(),
            "--preview-host needs a site named pr-<sha7>"
        );
        assert!(build_preview_url("pr-abcdef0", "alice-team", "example.com").is_ok());
        assert!(build_preview_url("pr-abcdef0", &"a".repeat(52), "example.com").is_ok());
        assert!(build_preview_url("pr-abcdef0", &"a".repeat(53), "example.com").is_err());
        assert!(build_preview_url("pr-abcdef0", "alice", "https://example.com").is_err());
        assert!(build_preview_url("pr-abcdef0", "alice", " example.com").is_err());
    }

    #[test]
    fn claims_come_from_wisp_domains_on_any_base_host() {
        let domains = serde_json::json!([
            {"domain": "alice.wisp.place", "kind": "wisp"},
            {"domain": "bob.wisp.localhost", "kind": "wisp"},
            {"domain": "blog.example.com", "kind": "custom"},
        ]);
        assert_eq!(
            wisp_claims(domains.as_array().unwrap()),
            vec!["alice".to_owned(), "bob".to_owned()]
        );
        assert!(wisp_claims(&[]).is_empty());
    }

    #[test]
    fn only_pr_sha7_sites_are_previews() {
        for site in ["pr-abcdef0", "pr-0123456"] {
            assert!(is_preview_site(site), "{site}");
        }
        for site in [
            "pr-abcdef",
            "pr-abcdef01",
            "pr-ABCDEF0",
            "xx-abcdef0",
            "pr-abcdeg0",
            "",
        ] {
            assert!(!is_preview_site(site), "{site}");
        }
    }
}
