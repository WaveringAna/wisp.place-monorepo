//! Account unlinking and credential removal.
use crate::{
    auth::{
        self, keychain,
        store::{AccountStore, StoredAccount},
    },
    cli::LogoutArgs,
};
use anyhow::Result;
use std::path::Path;

pub(super) fn open_store(path: Option<&Path>) -> Result<AccountStore> {
    path.map_or_else(AccountStore::open_default, AccountStore::open)
}

pub(super) async fn find_account(
    store: &AccountStore,
    identifier: &str,
) -> Result<Option<StoredAccount>> {
    match auth::resolver::resolve_identifier_to_did(store, identifier).await? {
        Some(did) => store.get_account(&did),
        None => Ok(None),
    }
}

pub(super) fn remove_credentials(store: &AccountStore, did: &str) -> Result<()> {
    keychain::delete_stored_oauth_session(did);
    keychain::delete_stored_app_password(did);
    for (key, _) in store.entries(&format!("oauth_index_v2:{did}/"))? {
        let session = key.replacen("oauth_index_v2:", "oauth_session_v2:", 1);
        keychain::remove_secret(&format!("oauth-v2:{session}"));
        store.delete(&session)?;
        store.delete(&key)?;
    }
    store.delete(&format!("oauth_session:{did}"))?;
    Ok(())
}

pub(super) async fn forget(store: &AccountStore, identifier: &str) -> Result<()> {
    if let Some(account) = find_account(store, identifier).await? {
        remove_credentials(store, &account.did)?;
        store.delete_account(&account.did)?;
        wisp_ui::out(format!(
            "Forgot {} and removed its stored credentials",
            account.handle.as_deref().unwrap_or(&account.did)
        ));
    } else {
        wisp_ui::out(format!("No stored account for {identifier}"));
    }
    Ok(())
}

pub async fn run(args: LogoutArgs) -> Result<()> {
    let store = open_store(args.db.db.as_deref())?;
    if args.all {
        let mut dids: std::collections::BTreeSet<_> =
            store.list_accounts()?.into_iter().map(|a| a.did).collect();
        dids.extend(
            store
                .entries("dir:")?
                .into_iter()
                .map(|(_, did)| did)
                .filter(|did| did.starts_with("did:")),
        );
        for did in dids {
            remove_credentials(&store, &did)?;
        }
        store.clear()?;
        wisp_ui::out("Cleared all stored accounts and credentials");
    } else if let Some(identifier) = args.handle {
        forget(&store, &identifier).await?;
    } else {
        store.delete_dir(&std::env::current_dir()?.to_string_lossy())?;
        wisp_ui::out("Unlinked the current directory (stored credentials kept)");
    }
    Ok(())
}
