use crate::{
    cli::{SiteArgs, SiteCommand, XrpcOptions},
    commands::list,
    prompts,
    xrpc::{self, items, text},
};
use anyhow::{Result, bail};
use serde_json::json;
use wisp_lexicons::place_wisp::v2::site;
use wisp_ui::{Choice, Line, s};

pub async fn run(args: SiteArgs) -> Result<()> {
    match args.command {
        Some(SiteCommand::Delete {
            handle,
            site,
            yes,
            xrpc,
        }) => delete(handle.as_deref(), site, yes, &xrpc).await,
        None => {
            wisp_ui::intro("site");
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
                delete(None, None, false, &args.xrpc).await
            }
        }
    }
}

async fn delete(
    handle: Option<&str>,
    rkey: Option<String>,
    yes: bool,
    opts: &XrpcOptions,
) -> Result<()> {
    let (agent, service, _) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let rkey = match rkey {
        Some(rkey) => rkey,
        None => {
            let spinner = wisp_ui::spinner("Fetching sites...");
            let data = xrpc::send(&agent, &service, site::get_list::GetList, None).await?;
            spinner.succeed("Fetched sites".to_owned());
            let sites = items(&data, "sites");
            if sites.is_empty() {
                bail!("No sites found for this account");
            }
            let choices = sites
                .iter()
                .map(|site| {
                    let choice =
                        Choice::new(text(site, "siteRkey").to_owned(), list::site_title(site));
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
            )?
        }
    };
    if !yes
        && !prompts::confirm(
            &format!("Delete site \"{rkey}\" and unmap its domains?"),
            "Site deletion cancelled",
            "Pass --yes to confirm deletion",
        )?
    {
        wisp_ui::cancelled("Site deletion cancelled");
        return Ok(());
    }
    let spinner = wisp_ui::spinner(format!("Deleting site {rkey}..."));
    let data =
        xrpc::call::<site::delete::Delete>(&agent, &service, json!({"siteRkey": rkey})).await?;
    spinner.succeed(format!("Deleted site {}", text(&data, "siteRkey")));
    if opts.json {
        return xrpc::json(&data);
    }
    wisp_ui::out(Line::from(vec![
        s::bold(text(&data, "siteRkey").to_owned()),
        s::plain(" deleted"),
    ]));
    let domains = items(&data, "unmappedDomains");
    if !domains.is_empty() {
        wisp_ui::out("Unmapped domains:");
        for domain in domains {
            wisp_ui::out(list::domain_line(domain, "- ", false));
        }
    }
    Ok(())
}
