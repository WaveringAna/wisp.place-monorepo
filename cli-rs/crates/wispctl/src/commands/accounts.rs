//! Stored account listing and default selection.
use super::logout::{find_account, forget, open_store};
use crate::{
    auth::{
        self, keychain,
        store::{AccountStore, AuthMethod, StoredAccount},
    },
    cli::{AccountsArgs, AccountsCommand, AccountsListArgs},
};
use anyhow::{Result, bail};
use serde::Serialize;
use wisp_ui::{Line, s};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountListing {
    #[serde(flatten)]
    account: StoredAccount,
    has_credential: bool,
    dirs: Vec<String>,
    is_default: bool,
    is_current_dir: bool,
}

fn has_credential(store: &AccountStore, did: &str) -> Result<bool> {
    for key in [did.to_owned(), format!("app-password:{did}")] {
        if keychain::read_secret(&key).is_some() {
            return Ok(true);
        }
    }
    for (key, _) in store.entries(&format!("oauth_index_v2:{did}/"))? {
        let session = key.replacen("oauth_index_v2:", "oauth_session_v2:", 1);
        if keychain::read_secret(&format!("oauth-v2:{session}")).is_some()
            || store.get(&session)?.is_some()
        {
            return Ok(true);
        }
    }
    Ok(store.get(&format!("oauth_session:{did}"))?.is_some())
}

async fn list(args: AccountsListArgs) -> Result<()> {
    let store = open_store(args.db.db.as_deref())?;
    let default = store.get_default()?;
    let current = store.get_dir(&std::env::current_dir()?.to_string_lossy())?;
    let mut listings = Vec::new();
    for mut account in store.list_accounts()? {
        if account.handle.is_none() {
            account.handle = auth::resolver::backfill_handle(&store, &account.did).await?;
        }
        listings.push(AccountListing {
            has_credential: has_credential(&store, &account.did)?,
            dirs: store.list_dirs_for_did(&account.did)?,
            is_default: default.as_deref() == Some(&account.did),
            is_current_dir: current.as_deref() == Some(&account.did),
            account,
        });
    }
    if args.json {
        wisp_ui::out_text(&serde_json::to_string_pretty(&listings)?);
        return Ok(());
    }
    if listings.is_empty() {
        wisp_ui::out("No stored accounts. Run `wispctl login <handle>` to add one.");
        return Ok(());
    }
    wisp_ui::out("");
    for listing in listings {
        let mut tags = vec![s::muted(
            if listing.account.method == AuthMethod::AppPassword {
                "app password"
            } else {
                "oauth"
            },
        )];
        for (show, tag) in [
            (!listing.has_credential, s::warn("no credential")),
            (listing.is_default, s::ok("default")),
            (listing.is_current_dir, s::accent("this directory")),
        ] {
            if show {
                tags.push(s::muted(", "));
                tags.push(tag);
            }
        }
        let mut line = vec![
            s::plain("  "),
            s::bold(
                listing
                    .account
                    .handle
                    .as_deref()
                    .unwrap_or(&listing.account.did)
                    .to_owned(),
            ),
            s::muted("  ("),
        ];
        line.extend(tags);
        line.push(s::muted(")"));
        wisp_ui::out(Line::from(line));
        if listing.account.handle.is_some() {
            wisp_ui::out(Line::from(s::muted(format!("    {}", listing.account.did))));
        }
        if !listing.dirs.is_empty() {
            let suffix = if listing.dirs.len() == 1 { "y" } else { "ies" };
            wisp_ui::out(Line::from(s::muted(format!(
                "    {} linked director{suffix}",
                listing.dirs.len()
            ))));
        }
    }
    wisp_ui::out("");
    Ok(())
}

pub async fn run(args: AccountsArgs) -> Result<()> {
    match args.command {
        None => list(args.list).await,
        Some(AccountsCommand::List(args)) => list(args).await,
        Some(AccountsCommand::Use { handle, db }) => {
            let store = open_store(db.db.as_deref())?;
            let Some(account) = find_account(&store, &handle).await? else {
                bail!("No stored account for {handle}. Run `wispctl login {handle}` first.");
            };
            store.set_default(&account.did)?;
            wisp_ui::out(format!(
                "Default account set to {}",
                account.handle.as_deref().unwrap_or(&account.did)
            ));
            Ok(())
        }
        Some(AccountsCommand::Remove { handle, db }) => {
            forget(&open_store(db.db.as_deref())?, &handle).await
        }
    }
}
