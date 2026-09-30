//! Deployment orchestrates repository effects around the pure tree/split planner.

use crate::deploy::{repo, repo::SiteRepo, upload};
use crate::{
    auth::{self, AuthOptions},
    cli::DeployArgs,
    prompts,
    xrpc::bind_auth_status,
};
use anyhow::{Result, bail};
use jacquard::types::{string::Datetime, tid::Tid};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use wisp_core::{
    blob::{is_text_mime, mime_for, should_compress},
    constants::{MAX_FILE_COUNT, MAX_FILE_SIZE, MAX_SITE_SIZE},
    convert::subfs_to_fs,
    ignore::collect_files,
    split::{manifest, split_plan, subfs_record},
    tree::{ExistingBlob, UploadResult, build_tree, extract_blob_map, extract_subfs_uris},
};
use wisp_lexicons::place_wisp::{fs::Fs, settings::Settings, subfs::SubfsRecord};
use wisp_ui::{TextPrompt, s};

fn valid_site(site: &str) -> bool {
    !site.is_empty()
        && site.len() <= 512
        && site
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._~:-".contains(&c))
}

pub async fn run(mut args: DeployArgs) -> Result<()> {
    let known = if args.handle.is_none() && args.password.is_none() {
        auth::resolve_account_for_cwd(args.db.db.as_deref()).await?
    } else {
        None
    };
    let needs_handle = args.handle.is_none() && known.is_none();
    let prompted = needs_handle || args.path.is_none() || args.site.is_none();
    if prompted {
        wisp_ui::intro("deploy");
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
    if args.concurrency == 0 {
        bail!("Concurrency must be at least 1");
    }
    let mut spinner = wisp_ui::spinner("Authenticating...");
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
    wisp_ui::blank();
    wisp_ui::note(wisp_ui::Line::from(vec![
        s::accent("Deploying "),
        s::bold(site.clone()),
        s::accent(format!(" from {}", path.display())),
    ]));
    wisp_ui::blank();
    let spinner = wisp_ui::spinner("Scanning directory...");
    let files = collect_files(&path)?;
    if files.is_empty() {
        spinner.fail("No files found to deploy".to_owned());
        bail!("No files found");
    }
    let size: u64 = files.iter().map(|file| file.size).sum();
    spinner.succeed(format!(
        "Found {} files ({})",
        files.len(),
        wisp_ui::format_bytes(size)
    ));
    if files.len() > MAX_FILE_COUNT {
        wisp_ui::warning(format!(
            "Warning: Site has {} files (limit: {MAX_FILE_COUNT})",
            files.len()
        ));
        wisp_ui::warning("Site may not be cached by the hosting service.");
    }
    if size > MAX_SITE_SIZE {
        wisp_ui::warning(format!(
            "Warning: Site is {} (limit: {})",
            wisp_ui::format_bytes(size),
            wisp_ui::format_bytes(MAX_SITE_SIZE)
        ));
        wisp_ui::warning("Site may not be cached by the hosting service.");
    }
    for file in files.iter().filter(|file| file.size > MAX_FILE_SIZE) {
        wisp_ui::warning(format!(
            "{} exceeds max size ({} > {})",
            file.relative_path,
            wisp_ui::format_bytes(file.size),
            wisp_ui::format_bytes(MAX_FILE_SIZE)
        ));
        wisp_ui::warning("This file may not be cached by the hosting service.");
    }
    let spinner = wisp_ui::spinner("Checking for existing site...");
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
    let spinner = wisp_ui::spinner("Creating manifest...");
    let writes = match put_manifest(&agent, &did, &site, &uploads).await {
        Ok(writes) => writes,
        Err(error) if repo::http_status(&error) == Some(500) => {
            wisp_ui::warning(
                "Manifest put failed with 500, retrying with base64 encoding for text files...",
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
            put_manifest(&agent, &did, &site, &uploads).await?
        }
        Err(error) => return Err(error),
    };
    spinner.succeed("Created manifest record".to_owned());
    if let Some(existing) = existing {
        for (owner, key) in existing.subfs {
            if owner == did && !writes.contains(&key) {
                // Best effort, like the old CLI: a leftover record is harmless.
                let _ = agent.delete::<SubfsRecord>(&key).await;
            }
        }
    }
    if args.directory || args.spa {
        let spinner = wisp_ui::spinner("Creating settings...");
        let settings: Settings = Settings {
            directory_listing: Some(args.directory),
            clean_urls: Some(true),
            spa_mode: args.spa.then(|| "index.html".into()),
            custom404: None,
            headers: None,
            index_files: None,
            extra_data: None,
        };
        agent.put(&site, settings).await?;
        spinner.succeed("Created settings record".to_owned());
    }
    wisp_ui::blank();
    wisp_ui::out(labelled(
        "URI",
        s::muted(format!("at://{did}/place.wisp.fs/{site}")),
    ));
    if let Some(handle) = args
        .handle
        .or_else(|| known.and_then(|account| account.handle))
    {
        wisp_ui::out(labelled(
            "URL",
            s::link(format!("https://sites.wisp.place/{handle}/{site}")),
        ));
    }
    wisp_ui::out(labelled(
        "URL",
        s::link(format!("https://sites.wisp.place/{did}/{site}")),
    ));
    if prompted {
        wisp_ui::outro("Deployed successfully!");
    } else {
        wisp_ui::blank();
        wisp_ui::success("Deployed successfully!");
    }
    Ok(())
}

async fn put_manifest(
    repo: &impl SiteRepo,
    did: &str,
    site: &str,
    uploads: &[(String, UploadResult)],
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
        .then(|| wisp_ui::spinner("Splitting large site into subfs records..."));
    let mut completed_messages = Vec::new();
    for message in plan.messages {
        if matches!(
            message,
            wisp_core::split::SplitMessage::CreatedParent { .. }
        ) {
            completed_messages.push(message);
        } else {
            wisp_ui::info(split_message(message));
        }
    }
    let mut keys = BTreeSet::new();
    for record in plan.records {
        repo.put(&record.rkey, subfs_record(&record, &created_at))
            .await?;
        keys.insert(record.rkey);
    }
    for message in completed_messages {
        wisp_ui::info(split_message(message));
    }
    if let Some(spinner) = splitting {
        spinner.succeed(format!("Created {} subfs records", keys.len()));
    }
    repo.put(site, manifest(site, &plan.directory, &created_at))
        .await?;
    Ok(keys)
}

fn split_message(message: wisp_core::split::SplitMessage) -> String {
    use wisp_core::split::SplitMessage;
    match message {
        SplitMessage::DirectoryTooLarge { size } => format!(
            "    → Directory too large ({}), splitting into chunks...",
            wisp_ui::format_bytes(size as u64)
        ),
        SplitMessage::CreatedChunks { count } => format!("    → Created {count} chunks"),
        SplitMessage::UploadingChunk {
            index,
            count,
            files,
            size,
        } => format!(
            "    → Uploading chunk {index}/{count} ({files} files, {})...",
            wisp_ui::format_bytes(size as u64)
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

struct ExistingSite {
    blobs: BTreeMap<String, ExistingBlob>,
    subfs: BTreeSet<(String, String)>,
}

async fn fetch_existing(repo: &impl SiteRepo, did: &str, site: &str) -> Option<ExistingSite> {
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
            let Ok(subject) = wisp_core::subfs::parse_subfs_subject(&uri) else {
                continue;
            };
            let (owner, key) = (subject.repo, subject.rkey);
            result.subfs.insert((owner.clone(), key.clone()));
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
            let Ok(record) = repo.fetch::<SubfsRecord>(&owner, &key).await else {
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
fn labelled(label: &str, value: wisp_ui::Span<'static>) -> wisp_ui::Line<'static> {
    wisp_ui::Line::from(vec![s::muted(format!("  {label}: ")), value])
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
}
