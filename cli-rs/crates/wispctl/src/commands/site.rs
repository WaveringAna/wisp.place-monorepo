use crate::{
    cli::{SiteArgs, SiteCommand, XrpcOptions},
    commands::{deploy::fetch_existing, list},
    deploy::repo::SiteRepo,
    prompts,
    xrpc::{self, items, text},
};
use anyhow::{Result, bail};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use wispplace_lexicons::place_wisp::{fs::Fs, settings::Settings, subfs::SubfsRecord, v2::site};
use wispplace_ui::{Choice, Line, s};

/// `site prune` only ever touches preview sites, whatever prefix it is given.
const PREVIEW_PREFIX: &str = "pr-";

pub async fn run(args: SiteArgs) -> Result<()> {
    match args.command {
        Some(SiteCommand::Delete {
            handle,
            site,
            records,
            ignore_missing,
            yes,
            xrpc,
        }) => delete(handle.as_deref(), site, records, ignore_missing, yes, &xrpc).await,
        Some(SiteCommand::Prune {
            handle,
            prefix,
            older_than,
            dry_run,
            yes,
            xrpc,
        }) => prune(handle.as_deref(), &prefix, older_than, dry_run, yes, &xrpc).await,
        None => {
            wispplace_ui::intro("site");
            let listing = prompts::select(
                "Choose site action",
                vec![
                    Choice::new(true, "List sites").hint("Show sites and mapped domains"),
                    Choice::new(false, "Delete site").hint("Remove site mapping metadata"),
                ],
                "Site command cancelled",
                "Pass a site subcommand",
            )?;
            if listing {
                list::sites(None, &args.xrpc).await
            } else {
                delete(None, Vec::new(), false, false, false, &args.xrpc).await
            }
        }
    }
}

async fn fetch_sites(agent: &crate::auth::WispAgent, service: &str) -> Result<Vec<Value>> {
    let spinner = wispplace_ui::spinner("Fetching sites...");
    let data = xrpc::send(agent, service, site::get_list::GetList, None).await?;
    spinner.succeed("Fetched sites".to_owned());
    Ok(items(&data, "sites").to_vec())
}

async fn delete(
    handle: Option<&str>,
    rkeys: Vec<String>,
    records: bool,
    ignore_missing: bool,
    yes: bool,
    opts: &XrpcOptions,
) -> Result<()> {
    let (agent, service, did) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let sites = fetch_sites(&agent, &service).await?;
    let rkeys = if rkeys.is_empty() {
        vec![choose_site(&sites)?]
    } else {
        rkeys
    };
    let listed: BTreeSet<&str> = sites.iter().map(|site| text(site, "siteRkey")).collect();
    if !ignore_missing
        && let Some(missing) = rkeys.iter().find(|rkey| !listed.contains(rkey.as_str()))
    {
        bail!("Site {missing} not found (pass --ignore-missing to skip it)");
    }
    let what = if records { " and its records" } else { "" };
    if !yes
        && !prompts::confirm(
            &format!("Delete {}{what} and unmap its domains?", describe(&rkeys)),
            "Site deletion cancelled",
            "Pass --yes to confirm deletion",
        )?
    {
        wispplace_ui::cancelled("Site deletion cancelled");
        return Ok(());
    }
    remove_sites(&agent, &service, &did, &rkeys, &listed, records, opts).await
}

async fn prune(
    handle: Option<&str>,
    prefix: &str,
    older_than: u32,
    dry_run: bool,
    yes: bool,
    opts: &XrpcOptions,
) -> Result<()> {
    if !prefix.starts_with(PREVIEW_PREFIX) {
        bail!("--prefix must start with \"{PREVIEW_PREFIX}\": prune only deletes preview sites");
    }
    let (agent, service, did) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let sites = fetch_sites(&agent, &service).await?;
    let cutoff = Utc::now() - Duration::days(i64::from(older_than));
    let stale = prunable(&sites, prefix, cutoff);
    if stale.is_empty() {
        wispplace_ui::out(s::muted("No matching sites to prune."));
        return Ok(());
    }
    for rkey in &stale {
        wispplace_ui::out(Line::from(vec![
            s::plain("- ".to_owned()),
            s::bold(rkey.clone()),
        ]));
    }
    if dry_run {
        wispplace_ui::out(s::muted(format!(
            "{} site(s) would be deleted.",
            stale.len()
        )));
        return Ok(());
    }
    if !yes
        && !prompts::confirm(
            &format!("Delete {} and their records?", describe(&stale)),
            "Prune cancelled",
            "Pass --yes to confirm deletion",
        )?
    {
        wispplace_ui::cancelled("Prune cancelled");
        return Ok(());
    }
    let listed: BTreeSet<&str> = stale.iter().map(String::as_str).collect();
    remove_sites(&agent, &service, &did, &stale, &listed, true, opts).await
}

/// Rkeys with `prefix` last touched before `cutoff`. A site with no readable
/// timestamp is never provably old, so it is kept.
fn prunable(sites: &[Value], prefix: &str, cutoff: DateTime<Utc>) -> Vec<String> {
    let touched = |site: &Value| {
        ["updatedAt", "createdAt"]
            .iter()
            .find_map(|key| DateTime::parse_from_rfc3339(site[*key].as_str()?).ok())
    };
    let mut stale: Vec<String> = sites
        .iter()
        .filter(|site| text(site, "siteRkey").starts_with(prefix))
        .filter(|site| touched(site).is_some_and(|at| at < cutoff))
        .map(|site| text(site, "siteRkey").to_owned())
        .collect();
    stale.sort();
    stale
}

fn describe(rkeys: &[String]) -> String {
    match rkeys {
        [only] => format!("site \"{only}\""),
        many => format!("{} sites", many.len()),
    }
}

fn choose_site(sites: &[Value]) -> Result<String> {
    if sites.is_empty() {
        bail!("No sites found for this account");
    }
    let choices = sites
        .iter()
        .map(|site| {
            let choice = Choice::new(text(site, "siteRkey").to_owned(), list::site_title(site));
            let count = items(site, "domains").len();
            if count > 0 {
                choice.hint(format!("{count} mapped domain(s)"))
            } else {
                choice
            }
        })
        .collect();
    prompts::select(
        "Select site to delete",
        choices,
        "Site deletion cancelled",
        "Pass --site <rkey>",
    )
}

/// Unmap through the service (for sites it knows), then optionally remove the
/// repo records. `listed` holds the rkeys the service reported.
async fn remove_sites(
    agent: &crate::auth::WispAgent,
    service: &str,
    did: &str,
    rkeys: &[String],
    listed: &BTreeSet<&str>,
    records: bool,
    opts: &XrpcOptions,
) -> Result<()> {
    let mut results = Vec::new();
    for rkey in rkeys {
        let spinner = wispplace_ui::spinner(format!("Deleting site {rkey}..."));
        let data = if listed.contains(rkey.as_str()) {
            xrpc::call::<site::delete::Delete>(agent, service, json!({"siteRkey": rkey})).await?
        } else {
            json!({"siteRkey": rkey, "deleted": false, "unmappedDomains": []})
        };
        if records {
            delete_records(agent, did, rkey).await?;
        }
        spinner.succeed(format!("Deleted site {rkey}"));
        results.push(data);
    }
    if opts.json {
        return match results.as_slice() {
            [only] => xrpc::json(only),
            many => xrpc::json(&Value::Array(many.to_vec())),
        };
    }
    for data in &results {
        wispplace_ui::out(Line::from(vec![
            s::bold(text(data, "siteRkey").to_owned()),
            s::plain(" deleted"),
        ]));
        let domains = items(data, "unmappedDomains");
        if !domains.is_empty() {
            wispplace_ui::out("Unmapped domains:");
            for domain in domains {
                wispplace_ui::out(list::domain_line(domain, "- ", false));
            }
        }
    }
    Ok(())
}

/// The manifest, its settings, and every subfs record it references. Deleting a
/// record that is already gone succeeds, so a rerun after a failure is safe.
async fn delete_records(repo: &impl SiteRepo, did: &str, rkey: &str) -> Result<()> {
    let subfs = fetch_existing(repo, did, rkey)
        .await
        .map(|site| site.subfs)
        .unwrap_or_default();
    repo.delete::<Fs>(rkey).await?;
    repo.delete::<Settings>(rkey).await?;
    for key in subfs {
        repo.delete::<SubfsRecord>(&key).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(rkey: &str, updated: Option<&str>, created: Option<&str>) -> Value {
        json!({"siteRkey": rkey, "updatedAt": updated, "createdAt": created, "domains": []})
    }

    #[test]
    fn prunes_only_matching_sites_older_than_the_cutoff() {
        let cutoff = DateTime::parse_from_rfc3339("2026-01-10T00:00:00Z")
            .unwrap()
            .into();
        let sites = [
            site("pr-aaaaaaa", Some("2026-01-01T00:00:00Z"), None),
            site("pr-bbbbbbb", Some("2026-01-20T00:00:00Z"), None),
            site("pr-ccccccc", None, Some("2026-01-02T00:00:00Z")),
            site("pr-ddddddd", None, None),
            site("blog", Some("2025-01-01T00:00:00Z"), None),
        ];
        assert_eq!(
            prunable(&sites, "pr-", cutoff),
            vec!["pr-aaaaaaa", "pr-ccccccc"]
        );
        assert_eq!(prunable(&sites, "pr-ccc", cutoff), vec!["pr-ccccccc"]);
    }
}
