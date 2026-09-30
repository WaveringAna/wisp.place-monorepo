use crate::{
    cli::{ListArgs, ListCommand, XrpcOptions},
    prompts,
    xrpc::{self, items, text},
};
use anyhow::Result;
use serde_json::Value;
use wisp_lexicons::place_wisp::v2::{domain, site};
use wisp_ui::{Choice, Line, s};

pub async fn run(args: ListArgs) -> Result<()> {
    match args.command {
        Some(ListCommand::Domains(args)) => domains(args.handle.as_deref(), &args.xrpc).await,
        Some(ListCommand::Sites(args)) => sites(args.handle.as_deref(), &args.xrpc).await,
        None => {
            wisp_ui::intro("list");
            let domains_selected = prompts::select(
                "What do you want to list?",
                vec![
                    Choice::new(true, "Domains").hint("Claimed, pending, and mapped domains"),
                    Choice::new(false, "Sites").hint("Sites with mapped domains"),
                ],
                "List cancelled",
                "Pass `list sites` or `list domains`",
            )?;
            if domains_selected {
                domains(None, &args.xrpc).await
            } else {
                sites(None, &args.xrpc).await
            }
        }
    }
}

pub fn domain_line(domain: &Value, prefix: &str, mapped: bool) -> Line<'static> {
    let status = text(domain, "status").to_owned();
    let mut spans = vec![
        s::plain(prefix.to_owned()),
        s::bold(text(domain, "domain").to_owned()),
        s::plain(format!(" [{}] ", text(domain, "kind"))),
        if status == "verified" {
            s::ok(status)
        } else {
            s::warn(status)
        },
    ];
    if mapped && let Some(site) = domain["siteRkey"].as_str().filter(|s| !s.is_empty()) {
        spans.push(s::plain(format!(" -> {site}")));
    }
    Line::from(spans)
}

pub async fn domains(handle: Option<&str>, opts: &XrpcOptions) -> Result<()> {
    let (agent, service, _) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let spinner = wisp_ui::spinner("Fetching domains...");
    let data = xrpc::send(&agent, &service, domain::get_list::GetList, None).await?;
    spinner.succeed("Fetched domains".to_owned());
    if opts.json {
        return xrpc::json(&data);
    }
    let domains = items(&data, "domains");
    if domains.is_empty() {
        wisp_ui::out(s::muted("No domains found."));
        return Ok(());
    }
    wisp_ui::out(s::bold(format!("Domains ({})", domains.len())));
    for domain in domains {
        wisp_ui::out(domain_line(domain, "- ", true));
    }
    Ok(())
}

pub async fn sites(handle: Option<&str>, opts: &XrpcOptions) -> Result<()> {
    let (agent, service, _) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let spinner = wisp_ui::spinner("Fetching sites...");
    let data = xrpc::send(&agent, &service, site::get_list::GetList, None).await?;
    spinner.succeed("Fetched sites".to_owned());
    if opts.json {
        return xrpc::json(&data);
    }
    let sites = items(&data, "sites");
    if sites.is_empty() {
        wisp_ui::out(s::muted("No sites found."));
        return Ok(());
    }
    wisp_ui::out(s::bold(format!("Sites ({})", sites.len())));
    for site in sites {
        wisp_ui::out(Line::from(vec![s::plain("- "), s::bold(site_title(site))]));
        let domains = items(site, "domains");
        if domains.is_empty() {
            wisp_ui::out(s::muted("  (no mapped domains)"));
        }
        for domain in domains {
            wisp_ui::out(domain_line(domain, "  ", false));
        }
    }
    Ok(())
}

pub fn site_title(site: &Value) -> String {
    match site["displayName"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => format!("{} ({name})", text(site, "siteRkey")),
        None => text(site, "siteRkey").to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn listings_keep_typescript_wording() {
        let domain = json!({"domain": "alice.wisp.place", "kind": "wisp", "status": "verified", "siteRkey": "blog"});
        assert_eq!(
            domain_line(&domain, "- ", true).to_string(),
            "- alice.wisp.place [wisp] verified -> blog"
        );
        assert_eq!(
            domain_line(&domain, "  ", false).to_string(),
            "  alice.wisp.place [wisp] verified"
        );
        assert_eq!(
            site_title(&json!({"siteRkey": "blog", "displayName": "My blog"})),
            "blog (My blog)"
        );
        assert_eq!(
            site_title(&json!({"siteRkey": "blog", "displayName": ""})),
            "blog"
        );
    }
}
