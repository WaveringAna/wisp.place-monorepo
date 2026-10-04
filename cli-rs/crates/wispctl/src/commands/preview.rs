use crate::{
    cli::{PreviewArgs, PreviewCommand, XrpcOptions},
    deploy::repo::{SiteRepo, http_status},
    xrpc,
};
use anyhow::{Result, bail};
use chrono::Utc;
use wispplace_lexicons::place_wisp::v2::{domain, wh};

pub async fn run(args: PreviewArgs) -> Result<()> {
    match args.command {
        PreviewCommand::Enable {
            handle,
            repo,
            claim,
            owner,
            bot_url,
            preview_host,
            xrpc,
        } => {
            enable(
                handle.as_deref(),
                &repo,
                claim.as_deref(),
                owner.as_deref(),
                &bot_url,
                preview_host.as_deref(),
                &xrpc,
            )
            .await
        }
        PreviewCommand::Disable { handle, repo, xrpc } => {
            disable(handle.as_deref(), &repo, &xrpc).await
        }
    }
}

fn valid_repo(repo: &str) -> bool {
    !repo.is_empty()
        && repo.len() <= 100
        && repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn valid_claim(claim: &str) -> bool {
    claim.len() <= 63
        && !claim.is_empty()
        && claim.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}
fn bot_url(value: &str) -> Result<String> {
    let value = value.trim_end_matches('/');
    if !value.starts_with("https://")
        || value[8..].is_empty()
        || value[8..].contains(['/', '?', '#'])
    {
        bail!("--bot-url must be an https origin")
    }
    Ok(value.to_owned())
}
fn hook_url(bot: &str, repo: &str, claim: &str, owner: Option<&str>) -> String {
    // application/x-www-form-urlencoded, byte for byte what URLSearchParams writes.
    fn encode(value: &str) -> String {
        value.bytes().fold(String::new(), |mut out, byte| {
            if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) {
                out.push(byte as char);
            } else if byte == b' ' {
                out.push('+');
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
            out
        })
    }
    let mut url = format!(
        "{bot}/v1/hook?repo={}&claim={}",
        encode(repo),
        encode(claim)
    );
    if let Some(owner) = owner {
        url.push_str("&owner=");
        url.push_str(&encode(owner));
    }
    url
}
fn rkey(repo: &str) -> String {
    format!("preview-{repo}")
}

async fn enable(
    handle: Option<&str>,
    repo: &str,
    claim: Option<&str>,
    owner: Option<&str>,
    bot: &str,
    preview_host: Option<&str>,
    opts: &XrpcOptions,
) -> Result<()> {
    // Keep these checks before authentication or any network access.
    if !valid_repo(repo) {
        bail!(
            "Invalid repository name: use 1–100 ASCII letters, digits, dots, underscores, or hyphens"
        );
    }
    let bot = bot_url(bot)?;
    if let Some(owner) = owner
        && (!owner.starts_with("did:")
            || owner.chars().any(char::is_whitespace)
            || owner.contains(['/', '?', '#']))
    {
        bail!("Invalid --owner: expected a DID");
    }
    if let Some(claim) = claim
        && !valid_claim(claim)
    {
        bail!(
            "Invalid claim label: use lowercase letters, digits, and single hyphens (up to 63 characters)"
        );
    }
    let (agent, service, did) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let claim = pick_claim(claim, account_claims(&agent, &service).await?)?;
    let owner = owner.filter(|owner| *owner != did);
    let record = wh::Wh {
        created_at: Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
            .parse()?,
        enabled: Some(true),
        events: Some(vec![wh::WhEvents::Create, wh::WhEvents::Update]),
        scope: wh::AtUri {
            aturi: format!("at://{did}/place.wisp.fs"),
            backlinks: None,
            backlinks_only: None,
            extra_data: None,
        },
        secret: None,
        secret_id: None,
        url: jacquard_common::types::string::UriValue::new(hook_url(&bot, repo, &claim, owner))?,
        extra_data: None,
    };
    agent
        .put(&rkey(repo), record)
        .await
        .map_err(|error| scope_error(error, "writing preview webhook"))?;
    wispplace_ui::success(format!("Enabled previews for {repo} (claim {claim})"));
    if let Some(host) = preview_host {
        wispplace_ui::out(format!("Preview URL pattern: pr-<sha7>-{claim}.{host}"));
    }
    wispplace_ui::note(
        "The repo still needs WISP_APP_PASSWORD on its spindle and the preview workflow.",
    );
    Ok(())
}

async fn disable(handle: Option<&str>, repo: &str, opts: &XrpcOptions) -> Result<()> {
    if !valid_repo(repo) {
        bail!(
            "Invalid repository name: use 1–100 ASCII letters, digits, dots, underscores, or hyphens"
        );
    }
    let (agent, _service, _did) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    match agent.delete::<wh::Wh>(&rkey(repo)).await {
        Ok(()) => {}
        Err(error) if http_status(&error) == Some(404) => {}
        Err(error) => return Err(scope_error(error, "deleting preview webhook")),
    }
    wispplace_ui::success(format!("Disabled previews for {repo}"));
    Ok(())
}

/// The account's verified wisp subdomain labels.
async fn account_claims(agent: &crate::auth::WispAgent, service: &str) -> Result<Vec<String>> {
    let data = xrpc::send(agent, service, domain::get_list::GetList, None).await?;
    Ok(xrpc::items(&data, "domains")
        .iter()
        .filter_map(|domain| {
            if domain["kind"].as_str() != Some("wisp")
                || domain["status"].as_str() != Some("verified")
            {
                return None;
            }
            Some(
                domain["domain"]
                    .as_str()?
                    .strip_suffix(".wisp.place")?
                    .to_owned(),
            )
        })
        .filter(|claim| valid_claim(claim))
        .collect())
}

/// The requested claim if the account holds it, or the account's only claim.
fn pick_claim(requested: Option<&str>, claims: Vec<String>) -> Result<String> {
    match (requested, claims.as_slice()) {
        (Some(claim), _) if claims.iter().any(|held| held == claim) => Ok(claim.to_owned()),
        (Some(claim), _) => bail!("{claim}.wisp.place is not claimed by this account"),
        (None, [claim]) => Ok(claim.clone()),
        (None, []) => bail!("Pass --claim <label>; this account has no wisp subdomain claim"),
        (None, _) => bail!("Pass --claim <label>; this account has multiple wisp subdomain claims"),
    }
}
fn scope_error(error: anyhow::Error, action: &str) -> anyhow::Error {
    if http_status(&error) == Some(403) {
        anyhow::anyhow!(
            "{action} was rejected because webhook access is missing; run `wispctl login <handle>` again to grant webhook access, or use an app password"
        )
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn record_parts_match_dashboard_encoding() {
        assert_eq!(rkey("my_repo.v2"), "preview-my_repo.v2");
        assert_eq!(
            hook_url(
                "https://preview-bot.wisp.place",
                "my_repo.v2",
                "pr-claim",
                None
            ),
            "https://preview-bot.wisp.place/v1/hook?repo=my_repo.v2&claim=pr-claim"
        );
        assert_eq!(
            hook_url("https://x.example", "a b", "x", Some("did:plc:a")),
            "https://x.example/v1/hook?repo=a+b&claim=x&owner=did%3Aplc%3Aa"
        );
    }
    #[test]
    fn invalid_values_are_rejected_without_network() {
        assert!(!valid_repo("bad/name"));
        assert!(!valid_repo(""));
        assert!(valid_repo("a.b_c-2"));
        assert!(!valid_claim("Bad"));
        assert!(!valid_claim("a--b"));
        assert!(valid_claim("pr-123"));
        assert!(bot_url("http://example.com").is_err());
    }
    #[test]
    fn claims_must_belong_to_the_account() {
        let held = || vec!["alice".to_owned(), "blog".to_owned()];
        assert_eq!(pick_claim(Some("blog"), held()).unwrap(), "blog");
        assert!(pick_claim(Some("bob"), held()).is_err());
        assert!(pick_claim(None, held()).is_err());
        assert_eq!(pick_claim(None, vec!["alice".into()]).unwrap(), "alice");
        assert!(pick_claim(None, vec![]).is_err());
    }
    #[test]
    fn encodes_like_url_search_params() {
        assert_eq!(
            hook_url("https://x.example", "a~b", "c", None),
            "https://x.example/v1/hook?repo=a%7Eb&claim=c"
        );
    }
}
