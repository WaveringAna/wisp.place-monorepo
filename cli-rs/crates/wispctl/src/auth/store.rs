//! SQLite bookkeeping compatible with the TypeScript CLI's account store.
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const HANDLE_ALIAS_TTL_MS: f64 = 86_400_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum AuthMethod {
    #[default]
    #[serde(rename = "oauth")]
    OAuth,
    #[serde(rename = "app-password")]
    AppPassword,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthScopeStrategy {
    Sets,
    Granular,
    Unknown(serde_json::Value),
}

impl Serialize for OAuthScopeStrategy {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Sets => serializer.serialize_str("sets"),
            Self::Granular => serializer.serialize_str("granular"),
            Self::Unknown(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for OAuthScopeStrategy {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some("sets") => Self::Sets,
            Some("granular") => Self::Granular,
            _ => Self::Unknown(value),
        })
    }
}

fn deserialize_scope<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<OAuthScopeStrategy>, D::Error> {
    OAuthScopeStrategy::deserialize(deserializer).map(Some)
}

/// Timestamps are JS `Date.now()` values: write whole milliseconds as integers,
/// as the TS CLI does, rather than `1735689600000.0`.
fn millis<S: serde::Serializer>(
    value: &f64,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

fn millis_opt<S: serde::Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    match value {
        Some(value) => millis(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub method: AuthMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pds_url: Option<String>,
    #[serde(serialize_with = "millis")]
    pub added_at: f64,
    #[serde(serialize_with = "millis")]
    pub last_used_at: f64,
    #[serde(serialize_with = "millis_opt", skip_serializing_if = "Option::is_none")]
    pub handle_checked_at: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_scope",
        skip_serializing_if = "Option::is_none"
    )]
    pub oauth_scope: Option<OAuthScopeStrategy>,
}

#[derive(Debug, Clone, Default)]
pub struct AccountUpdates {
    pub handle: Option<String>,
    pub method: Option<AuthMethod>,
    pub pds_url: Option<String>,
    pub handle_checked: bool,
    pub oauth_scope: Option<OAuthScopeStrategy>,
}

pub fn normalize_handle(handle: &str) -> String {
    let normalized = handle.trim().to_lowercase();
    normalized
        .strip_prefix('@')
        .unwrap_or(&normalized)
        .to_owned()
}

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

pub fn default_db_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context("Could not determine home directory")?;
    Ok(PathBuf::from(home).join(".config/wispctl/state.sqlite"))
}

fn parse_account(raw: &str) -> Option<StoredAccount> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let fields = value.as_object()?;
    // Optional fields may be absent, but explicit null is not a TS string/number.
    for name in ["handle", "pdsUrl"] {
        if fields.get(name).is_some_and(|v| !v.is_string()) {
            return None;
        }
    }
    if fields
        .get("handleCheckedAt")
        .is_some_and(|v| !v.is_number())
    {
        return None;
    }
    let account: StoredAccount = serde_json::from_value(value).ok()?;
    (account.did.starts_with("did:")
        && account.added_at.is_finite()
        && account.last_used_at.is_finite()
        && account.handle_checked_at.is_none_or(f64::is_finite))
    .then_some(account)
}

pub struct AccountStore {
    connection: Connection,
}

impl AccountStore {
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path()?)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if path != Path::new(":memory:") {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(parent)?;
            let mut options = fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            }
        }
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);")?;
        let store = Self { connection };
        store.migrate_dir_mappings()?;
        Ok(store)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let row: Option<(String, Option<f64>)> = self
            .connection
            .query_row(
                "SELECT value, expires_at FROM kv WHERE key = ?",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            Some((_, Some(expires))) if expires <= now_ms() => {
                self.delete(key)?;
                Ok(None)
            }
            Some((value, _)) => Ok(Some(value)),
            None => Ok(None),
        }
    }

    pub fn set(&self, key: &str, value: &str, ttl_seconds: Option<f64>) -> Result<()> {
        self.connection.execute(
            "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)",
            params![key, value, ttl_seconds.map(|ttl| now_ms() + ttl * 1000.0)],
        )?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM kv WHERE key = ?", [key])?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        self.connection.execute("DELETE FROM kv", [])?;
        Ok(())
    }

    pub fn entries(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let escaped = prefix
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
            + "%";
        let mut statement = self
            .connection
            .prepare("SELECT key, value, expires_at FROM kv WHERE key LIKE ? ESCAPE '\\'")?;
        let rows = statement.query_map([escaped], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<f64>>(2)?,
            ))
        })?;
        let now = now_ms();
        let mut entries = Vec::new();
        for row in rows {
            let (key, value, expires) = row?;
            if expires.is_none_or(|expires| expires > now) {
                entries.push((key, value));
            }
        }
        Ok(entries)
    }

    pub fn get_account(&self, did: &str) -> Result<Option<StoredAccount>> {
        Ok(self
            .get(&format!("account:{did}"))?
            .and_then(|raw| parse_account(&raw)))
    }

    pub fn write_account(&self, account: &StoredAccount) -> Result<()> {
        self.set(
            &format!("account:{}", account.did),
            &serde_json::to_string(account)?,
            None,
        )?;
        if let Some(handle) = account.handle.as_ref().filter(|h| !h.is_empty()) {
            self.set(&format!("handle:{handle}"), &account.did, None)?;
        }
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<StoredAccount>> {
        let mut accounts: Vec<_> = self
            .entries("account:")?
            .into_iter()
            .filter_map(|(_, raw)| parse_account(&raw))
            .collect();
        accounts.sort_by_cached_key(|account| {
            let label = account.handle.as_ref().unwrap_or(&account.did);
            (label.to_lowercase(), label.clone())
        });
        Ok(accounts)
    }

    pub fn detach_handle(&self, did: &str, handle: &str) -> Result<()> {
        let key = format!("handle:{handle}");
        if self.get(&key)?.as_deref() == Some(did) {
            self.delete(&key)?;
        }
        if let Some(mut account) = self.get_account(did)?
            && account.handle.as_deref() == Some(handle)
        {
            account.handle = None;
            account.handle_checked_at = None;
            self.set(
                &format!("account:{did}"),
                &serde_json::to_string(&account)?,
                None,
            )?;
        }
        Ok(())
    }

    pub fn upsert_account(&self, did: &str, updates: &AccountUpdates) -> Result<StoredAccount> {
        let now = now_ms();
        let existing = self.get_account(did)?;
        let old_handle = existing.as_ref().and_then(|a| a.handle.clone());
        let handle = updates
            .handle
            .as_ref()
            .filter(|h| !h.is_empty())
            .map(|h| normalize_handle(h))
            .or_else(|| old_handle.clone());
        if let Some(old) = old_handle
            .as_ref()
            .filter(|old| Some(*old) != handle.as_ref())
        {
            self.detach_handle(did, old)?;
        }
        if let Some(handle) = handle.as_ref().filter(|h| !h.is_empty())
            && let Some(owner) = self
                .get(&format!("handle:{handle}"))?
                .filter(|owner| owner != did)
        {
            self.detach_handle(&owner, handle)?;
        }
        let account = StoredAccount {
            did: did.to_owned(),
            handle_checked_at: if updates.handle_checked {
                Some(now)
            } else if handle != old_handle {
                None
            } else {
                existing.as_ref().and_then(|a| a.handle_checked_at)
            },
            handle,
            method: updates
                .method
                .or_else(|| existing.as_ref().map(|a| a.method))
                .unwrap_or_default(),
            pds_url: updates
                .pds_url
                .clone()
                .or_else(|| existing.as_ref().and_then(|a| a.pds_url.clone())),
            added_at: existing.as_ref().map_or(now, |a| a.added_at),
            last_used_at: now,
            oauth_scope: updates
                .oauth_scope
                .clone()
                .or_else(|| existing.as_ref().and_then(|a| a.oauth_scope.clone())),
        };
        self.write_account(&account)?;
        Ok(account)
    }

    pub fn delete_account(&self, did: &str) -> Result<()> {
        if let Some(handle) = self.get_account(did)?.and_then(|a| a.handle) {
            self.delete(&format!("handle:{handle}"))?;
        }
        for prefix in ["handle:", "dir:"] {
            for (key, value) in self.entries(prefix)? {
                if value == did {
                    self.delete(&key)?;
                }
            }
        }
        if self.get_default()?.as_deref() == Some(did) {
            self.delete("default_account")?;
        }
        self.delete(&format!("account:{did}"))
    }

    pub fn get_dir(&self, dir: &str) -> Result<Option<String>> {
        self.get(&format!("dir:{dir}"))
    }
    pub fn set_dir(&self, dir: &str, did: &str) -> Result<()> {
        self.set(&format!("dir:{dir}"), did, None)
    }
    pub fn delete_dir(&self, dir: &str) -> Result<()> {
        self.delete(&format!("dir:{dir}"))
    }
    pub fn get_default(&self) -> Result<Option<String>> {
        self.get("default_account")
    }
    pub fn set_default(&self, did: &str) -> Result<()> {
        self.set("default_account", did, None)
    }

    pub fn list_dirs_for_did(&self, did: &str) -> Result<Vec<String>> {
        Ok(self
            .entries("dir:")?
            .into_iter()
            .filter(|(_, value)| value == did)
            .map(|(key, _)| key[4..].to_owned())
            .collect())
    }

    pub fn resolve_account_for_dir(&self, dir: &str) -> Result<Option<StoredAccount>> {
        if let Some(did) = self.get_dir(dir)? {
            return Ok(Some(match self.get_account(&did)? {
                Some(account) => account,
                None => self.upsert_account(&did, &AccountUpdates::default())?,
            }));
        }
        if let Some(did) = self.get_default()?
            && let Some(account) = self.get_account(&did)?
        {
            return Ok(Some(account));
        }
        let mut accounts = self.list_accounts()?;
        Ok(if accounts.len() == 1 {
            accounts.pop()
        } else {
            None
        })
    }

    pub fn cached_identifier(&self, identifier: &str) -> Result<Option<String>> {
        if identifier.starts_with("did:") {
            return Ok(Some(identifier.to_owned()));
        }
        self.get(&format!("handle:{}", normalize_handle(identifier)))
    }

    pub fn alias_is_fresh(&self, did: &str, handle: &str) -> Result<bool> {
        Ok(self.get_account(did)?.is_some_and(|a| {
            a.handle.as_deref() == Some(handle)
                && a.handle_checked_at
                    .is_some_and(|checked| now_ms() - checked < HANDLE_ALIAS_TTL_MS)
        }))
    }

    fn migrate_dir_mappings(&self) -> Result<()> {
        if self.get("store_version")?.as_deref() == Some("1") {
            return Ok(());
        }
        for (_, did) in self.entries("dir:")? {
            if did.starts_with("did:") && self.get_account(&did)?.is_none() {
                self.upsert_account(&did, &AccountUpdates::default())?;
            }
        }
        self.set("store_version", "1", None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn memory() -> AccountStore {
        AccountStore::open(":memory:").unwrap()
    }

    #[test]
    fn kv_expiry_and_literal_prefixes() {
        let store = memory();
        store.set("a_%\\one", "yes", None).unwrap();
        store.set("aXXone", "no", None).unwrap();
        assert_eq!(
            store.entries("a_%\\").unwrap(),
            vec![("a_%\\one".into(), "yes".into())]
        );
        store.set("expired", "old", Some(-1.0)).unwrap();
        assert!(store.entries("expired").unwrap().is_empty());
        assert!(
            store
                .connection
                .query_row("SELECT value FROM kv WHERE key='expired'", [], |r| r
                    .get::<_, String>(0))
                .is_ok()
        );
        assert_eq!(store.get("expired").unwrap(), None);
        assert!(
            store
                .connection
                .query_row("SELECT value FROM kv WHERE key='expired'", [], |r| r
                    .get::<_, String>(0))
                .is_err()
        );
        store.set("zero", "old", Some(0.0)).unwrap();
        assert_eq!(store.get("zero").unwrap(), None);
    }

    #[test]
    fn unique_handle_alias_and_handle_changes() {
        let store = memory();
        let update = AccountUpdates {
            handle: Some("@ALICE.EXAMPLE".into()),
            handle_checked: true,
            ..Default::default()
        };
        store.upsert_account("did:plc:old", &update).unwrap();
        let new = store.upsert_account("did:plc:new", &update).unwrap();
        assert!(
            store
                .get_account("did:plc:old")
                .unwrap()
                .unwrap()
                .handle
                .is_none()
        );
        assert_eq!(new.handle.as_deref(), Some("alice.example"));
        assert_eq!(
            store
                .cached_identifier(" @ALICE.EXAMPLE ")
                .unwrap()
                .as_deref(),
            Some("did:plc:new")
        );
        assert!(
            store
                .alias_is_fresh("did:plc:new", "alice.example")
                .unwrap()
        );
        let changed = store
            .upsert_account(
                "did:plc:new",
                &AccountUpdates {
                    handle: Some("bob.example".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(changed.added_at, new.added_at);
        assert!(changed.handle_checked_at.is_none());
        assert!(store.cached_identifier("alice.example").unwrap().is_none());
    }

    #[test]
    fn malformed_rows_and_camel_case_shape() {
        let store = memory();
        for raw in [
            r#"{"did":"did:plc:broken","method":"unknown"}"#,
            r#"{"did":"did:plc:broken","method":"oauth","addedAt":1,"lastUsedAt":1,"handle":null}"#,
        ] {
            store.set("account:did:plc:broken", raw, None).unwrap();
            assert!(store.get_account("did:plc:broken").unwrap().is_none());
            assert!(store.list_accounts().unwrap().is_empty());
        }
        let account = store
            .upsert_account("did:plc:ok", &AccountUpdates::default())
            .unwrap();
        let value = serde_json::to_value(account).unwrap();
        assert!(value.get("addedAt").is_some());
        assert!(value.get("lastUsedAt").is_some());
        assert!(value.get("handle").is_none());
        assert_eq!(value["method"], "oauth");
    }

    #[test]
    fn lists_accounts_in_case_insensitive_order() {
        let store = memory();
        for (did, handle) in [
            ("did:plc:z", "z.example"),
            ("did:plc:e", "é.example"),
            ("did:plc:a", "a.example"),
        ] {
            store
                .upsert_account(
                    did,
                    &AccountUpdates {
                        handle: Some(handle.into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let handles: Vec<_> = store
            .list_accounts()
            .unwrap()
            .into_iter()
            .map(|a| a.handle.unwrap())
            .collect();
        assert_eq!(handles, ["a.example", "z.example", "é.example"]);
    }

    #[test]
    fn accepts_unknown_scope_values_and_retains_bookkeeping() {
        let store = memory();
        for scope in [
            serde_json::json!("future"),
            serde_json::json!(null),
            serde_json::json!({"future": true}),
            serde_json::json!(42),
        ] {
            let raw = serde_json::json!({
                "did": "did:plc:scope",
                "method": "app-password",
                "addedAt": 12.5,
                "lastUsedAt": 13,
                "oauthScope": scope,
                "pdsUrl": "https://pds.example"
            });
            store
                .set("account:did:plc:scope", &raw.to_string(), None)
                .unwrap();
            let account = store.get_account("did:plc:scope").unwrap().unwrap();
            assert_eq!(serde_json::to_value(&account).unwrap()["oauthScope"], scope);
            let updated = store
                .upsert_account(&account.did, &AccountUpdates::default())
                .unwrap();
            assert_eq!(updated.method, AuthMethod::AppPassword);
            assert_eq!(updated.added_at, 12.5);
            assert_eq!(updated.pds_url.as_deref(), Some("https://pds.example"));
            assert_eq!(serde_json::to_value(updated).unwrap()["oauthScope"], scope);
        }
    }

    #[test]
    fn alias_ttl_and_stale_default_fallback() {
        let store = memory();
        let mut account = store
            .upsert_account(
                "did:plc:a",
                &AccountUpdates {
                    handle: Some("a.example".into()),
                    handle_checked: true,
                    ..Default::default()
                },
            )
            .unwrap();
        account.handle_checked_at = Some(now_ms() - HANDLE_ALIAS_TTL_MS);
        store.write_account(&account).unwrap();
        assert!(!store.alias_is_fresh(&account.did, "a.example").unwrap());
        assert_eq!(
            store.cached_identifier("A.EXAMPLE").unwrap().as_deref(),
            Some("did:plc:a")
        );
        assert!(!store.alias_is_fresh(&account.did, "other.example").unwrap());
        store.set_default("did:plc:missing").unwrap();
        assert_eq!(
            store
                .resolve_account_for_dir("/unused")
                .unwrap()
                .unwrap()
                .did,
            account.did
        );
        store.delete_dir("/unused").unwrap();
        store.clear().unwrap();
        assert!(store.entries("").unwrap().is_empty());
    }

    #[test]
    fn resolution_precedence_and_cleanup() {
        let store = memory();
        store
            .upsert_account("did:plc:a", &AccountUpdates::default())
            .unwrap();
        assert_eq!(
            store.resolve_account_for_dir("/x").unwrap().unwrap().did,
            "did:plc:a"
        );
        store
            .upsert_account("did:plc:b", &AccountUpdates::default())
            .unwrap();
        assert!(store.resolve_account_for_dir("/x").unwrap().is_none());
        store.set_default("did:plc:a").unwrap();
        assert_eq!(
            store.resolve_account_for_dir("/x").unwrap().unwrap().did,
            "did:plc:a"
        );
        store.set_dir("/x", "did:plc:b").unwrap();
        assert_eq!(
            store.resolve_account_for_dir("/x").unwrap().unwrap().did,
            "did:plc:b"
        );
        store.set_dir("/legacy", "did:plc:legacy").unwrap();
        assert_eq!(
            store
                .resolve_account_for_dir("/legacy")
                .unwrap()
                .unwrap()
                .method,
            AuthMethod::OAuth
        );
        store.set("handle:stale", "did:plc:a", None).unwrap();
        store.set_dir("/a", "did:plc:a").unwrap();
        store.delete_account("did:plc:a").unwrap();
        assert!(store.get_default().unwrap().is_none());
        assert!(store.get_dir("/a").unwrap().is_none());
        assert!(store.cached_identifier("stale").unwrap().is_none());
        store.delete_account("did:plc:missing").unwrap();
    }

    #[test]
    fn migrates_legacy_mappings_and_secures_database() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let parent = std::env::temp_dir().join(format!(
            "wispctl-store-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = parent.join("config/state.sqlite");
        {
            let store = AccountStore::open(&path).unwrap();
            store.delete("store_version").unwrap();
            store.set_dir("/legacy", "did:plc:old").unwrap();
            store.set_dir("/invalid", "not-a-did").unwrap();
        }
        let store = AccountStore::open(&path).unwrap();
        assert!(store.get_account("did:plc:old").unwrap().is_some());
        assert!(store.get_account("not-a-did").unwrap().is_none());
        assert_eq!(store.get("store_version").unwrap().as_deref(), Some("1"));
        let journal: String = store
            .connection
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        drop(store);
        fs::remove_dir_all(parent).unwrap();
    }
}
