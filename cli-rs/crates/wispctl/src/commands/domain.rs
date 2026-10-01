use crate::{
    cli::{DomainArgs, DomainCommand},
    prompts,
    xrpc::{self, text},
};
use anyhow::Result;
use serde_json::{Value, json};
use wisp_lexicons::place_wisp::v2::domain;
use wisp_ui::{Choice, Line, s};

pub async fn run(args: DomainArgs) -> Result<()> {
    let command = match args.command {
        Some(command) => command,
        None => {
            wisp_ui::intro("domain");
            let action = prompts::select(
                "Choose domain action",
                vec![
                    Choice::new("claim", "Claim custom domain"),
                    Choice::new("claim-subdomain", "Claim wisp subdomain"),
                    Choice::new("status", "Get domain status"),
                    Choice::new("add-site", "Map domain to site"),
                    Choice::new("verify", "Verify domain"),
                    Choice::new("delete", "Delete domain"),
                ],
                "Domain command cancelled",
                "Pass a domain subcommand",
            )?;
            match action {
                "claim" => DomainCommand::Claim {
                    handle: None,
                    domain: None,
                    site: None,
                    xrpc: args.xrpc,
                },
                "claim-subdomain" => DomainCommand::ClaimSubdomain {
                    handle: None,
                    subdomain: None,
                    site: None,
                    xrpc: args.xrpc,
                },
                "status" => DomainCommand::Status {
                    handle: None,
                    domain: None,
                    xrpc: args.xrpc,
                },
                "add-site" => DomainCommand::AddSite {
                    handle: None,
                    domain: None,
                    site: None,
                    xrpc: args.xrpc,
                },
                "verify" => DomainCommand::Verify {
                    handle: None,
                    domain: None,
                    xrpc: args.xrpc,
                },
                _ => DomainCommand::Delete {
                    handle: None,
                    domain: None,
                    xrpc: args.xrpc,
                },
            }
        }
    };
    let (action, handle, value, site, opts) = match command {
        DomainCommand::Claim {
            handle,
            domain,
            site,
            xrpc,
        } => ("claim", handle, domain, site, xrpc),
        DomainCommand::ClaimSubdomain {
            handle,
            subdomain,
            site,
            xrpc,
        } => ("claim-subdomain", handle, subdomain, site, xrpc),
        DomainCommand::Status {
            handle,
            domain,
            xrpc,
        } => ("status", handle, domain, None, xrpc),
        DomainCommand::AddSite {
            handle,
            domain,
            site,
            xrpc,
        } => ("add-site", handle, domain, site, xrpc),
        DomainCommand::Verify {
            handle,
            domain,
            xrpc,
        } => ("verify", handle, domain, None, xrpc),
        DomainCommand::Delete {
            handle,
            domain,
            xrpc,
        } => ("delete", handle, domain, None, xrpc),
    };
    let cancel = match action {
        "claim" | "claim-subdomain" => "Claim cancelled",
        "status" => "Status check cancelled",
        "add-site" => "Add-site cancelled",
        "verify" => "Verify cancelled",
        _ => "Delete cancelled",
    };
    let value = match value {
        Some(value) => value,
        None if action == "claim-subdomain" => prompts::required_value(
            "Subdomain handle",
            "alice",
            "Subdomain is required",
            cancel,
            "Pass --subdomain <name>",
        )?,
        None => prompts::required_value(
            if action == "claim" {
                "Custom domain"
            } else {
                "Domain"
            },
            "example.com",
            "Domain is required",
            cancel,
            "Pass --domain <domain>",
        )?,
    };
    let site = if action == "add-site" && site.is_none() {
        Some(prompts::required_value(
            "Site rkey",
            "mysite",
            "Site rkey is required",
            cancel,
            "Pass --site <rkey>",
        )?)
    } else {
        site
    };
    let (agent, service, _) = xrpc::authenticate_for_xrpc(handle.as_deref(), &opts).await?;
    let label = match action {
        "claim" => format!("Claiming {value}..."),
        "claim-subdomain" => format!("Claiming subdomain {value}..."),
        "status" => format!("Fetching status for {value}..."),
        "add-site" => format!("Mapping {value} -> {}...", site.as_deref().unwrap_or("")),
        "verify" => format!("Verifying {value}..."),
        _ => format!("Deleting {value}..."),
    };
    let spinner = wisp_ui::spinner(label);
    let mut input = json!({"domain": value});
    if let Some(site) = site {
        input["siteRkey"] = json!(site);
    }
    let data = match action {
        "claim" => xrpc::call::<domain::claim::Claim>(&agent, &service, input).await?,
        "claim-subdomain" => {
            input["handle"] = input["domain"].take();
            input.as_object_mut().unwrap().remove("domain");
            xrpc::call::<domain::claim_subdomain::ClaimSubdomain>(&agent, &service, input).await?
        }
        "status" => xrpc::call::<domain::get_status::GetStatus>(&agent, &service, input).await?,
        "add-site" => xrpc::call::<domain::add_site::AddSite>(&agent, &service, input).await?,
        "verify" => xrpc::call::<domain::verify::Verify>(&agent, &service, input).await?,
        _ => xrpc::call::<domain::delete::Delete>(&agent, &service, input).await?,
    };
    let domain = text(&data, "domain");
    if action == "verify" && data["verified"] != true {
        let error = data["error"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!(": {s}"))
            .unwrap_or_default();
        spinner.fail(format!("{domain} not verified{error}"));
    } else {
        let completed = match action {
            "claim" | "claim-subdomain" => format!("Claimed {domain}"),
            "status" => format!("Fetched status for {domain}"),
            "add-site" => format!("Mapped {domain}"),
            "verify" => format!("Verified {domain}"),
            _ => format!("Deleted {domain}"),
        };
        spinner.succeed(completed);
    }
    if opts.json {
        return xrpc::json(&data);
    }
    render(action, &data);
    Ok(())
}

fn render(action: &str, data: &Value) {
    let domain = text(data, "domain").to_owned();
    let suffix = match action {
        "delete" => " deleted".to_owned(),
        "add-site" => format!(" -> {} ({})", text(data, "siteRkey"), text(data, "status")),
        "verify" => format!(
            " {}",
            if data["verified"] == true {
                "verified"
            } else {
                text(data, "status")
            }
        ),
        _ => format!(" -> {}", text(data, "status")),
    };
    wisp_ui::out(Line::from(vec![
        s::bold(domain),
        if action == "verify" {
            if data["verified"] == true {
                s::ok(suffix)
            } else {
                s::warn(suffix)
            }
        } else {
            s::plain(suffix)
        },
    ]));
    if action == "claim" {
        if let (Some(name), Some(value)) = (data["txtName"].as_str(), data["txtValue"].as_str()) {
            wisp_ui::out(format!("TXT: {name} = {value}"));
        }
        field(data, "cnameTarget", "CNAME");
    }
    if action == "status" {
        field(data, "kind", "Kind");
        if let Some(verified) = data["verified"].as_bool() {
            wisp_ui::out(format!("Verified: {verified}"));
        }
    }
    if matches!(action, "claim" | "claim-subdomain" | "status") {
        field(data, "siteRkey", "Mapped site");
    }
    if action == "status" {
        field(data, "lastCheckedAt", "Last checked");
        field(data, "lastError", "Last error");
    }
    if action == "verify"
        && let Some(warning) = data["warning"].as_str().filter(|s| !s.is_empty())
    {
        wisp_ui::out(s::warn(format!("warning: {warning}")));
    }
}

fn field(data: &Value, key: &str, label: &str) {
    if let Some(value) = data[key].as_str().filter(|s| !s.is_empty()) {
        wisp_ui::out(format!("{label}: {value}"));
    }
}
