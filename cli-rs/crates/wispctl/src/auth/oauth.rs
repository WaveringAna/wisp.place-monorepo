//! Jacquard OAuth sessions have a separate namespace from the TypeScript client.
use super::{
    keychain,
    resolver::EnvResolver,
    store::{AccountStore, OAuthScopeStrategy},
};
use anyhow::{Result, bail};
use jacquard::{
    BosStr, SmolStr,
    deps::fluent_uri::Uri,
    oauth::{
        atproto::AtprotoClientMetadata,
        authstore::ClientAuthStore,
        client::{OAuthClient, OAuthSession},
        scopes::Scopes,
        session::{AuthRequestData, ClientData, ClientSessionData},
        types::{AuthorizeOptions, CallbackParams},
    },
    session::{SessionKey, SessionStoreError},
    types::string::Did,
};
use serde::{Serialize, de::DeserializeOwned};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

pub type Session = OAuthSession<EnvResolver, OAuthStore>;
type Client = OAuthClient<EnvResolver, OAuthStore>;

pub struct OAuthStore {
    pub db: Arc<Mutex<AccountStore>>,
    warned: AtomicBool,
    secrets: Arc<dyn Secrets>,
}

trait Secrets: Send + Sync {
    fn read(&self, key: &str) -> Option<String>;
    fn write(&self, key: &str, value: &str) -> bool;
    fn remove(&self, key: &str);
}
struct SystemSecrets;
impl Secrets for SystemSecrets {
    fn read(&self, key: &str) -> Option<String> {
        keychain::read_secret(key)
    }
    fn write(&self, key: &str, value: &str) -> bool {
        keychain::write_secret(key, value)
    }
    fn remove(&self, key: &str) {
        keychain::remove_secret(key);
    }
}

fn store_error(err: anyhow::Error) -> SessionStoreError {
    SessionStoreError::Other(err.into())
}

impl OAuthStore {
    pub fn new(db: Arc<Mutex<AccountStore>>) -> Self {
        Self {
            db,
            warned: AtomicBool::new(false),
            secrets: Arc::new(SystemSecrets),
        }
    }
    fn read<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let secret = if key.starts_with("oauth_session_v2:") {
            self.secrets.read(&format!("oauth-v2:{key}"))
        } else {
            None
        };
        let value = match secret {
            Some(value) => Some(value),
            None => self
                .db
                .lock()
                .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
                .get(key)?,
        };
        value
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(Into::into)
    }
    fn write<T: Serialize>(&self, key: &str, value: &T, ttl: f64, secret: bool) -> Result<()> {
        let value = serde_json::to_string(value)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?;
        if secret && self.secrets.write(&format!("oauth-v2:{key}"), &value) {
            db.delete(key)?;
        } else {
            if secret && !self.warned.swap(true, Ordering::Relaxed) {
                wisp_ui::warning(
                    "Could not save the session in the system credential store; keeping it in the local wispctl database instead.",
                );
            }
            // A refused keychain write must not leave a stale secret shadowing SQLite.
            if secret {
                self.secrets.remove(&format!("oauth-v2:{key}"));
            }
            db.set(key, &value, Some(ttl))?;
        }
        Ok(())
    }
    fn remove(&self, key: &str) -> Result<()> {
        if key.starts_with("oauth_session_v2:") {
            self.secrets.remove(&format!("oauth-v2:{key}"));
        }
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
            .delete(key)
    }
    pub fn session_key(did: &str, id: &str) -> String {
        format!("oauth_session_v2:{did}/{id}")
    }
    pub fn keys(&self) -> Result<Vec<SessionKey>> {
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
            .entries("oauth_index_v2:")?
            .into_iter()
            .map(|(_, value)| serde_json::from_str(&value).map_err(Into::into))
            .collect()
    }
}

impl ClientAuthStore for OAuthStore {
    async fn get_session<D: BosStr + Send + Sync>(
        &self,
        did: &Did<D>,
        session_id: &str,
    ) -> std::result::Result<Option<ClientSessionData>, SessionStoreError> {
        self.read(&Self::session_key(did.as_str(), session_id))
            .map_err(store_error)
    }
    async fn upsert_session(
        &self,
        session: ClientSessionData,
    ) -> std::result::Result<(), SessionStoreError> {
        let key = Self::session_key(session.account_did.as_str(), session.session_id.as_str());
        self.write(&key, &session, 14.0 * 86400.0, true)
            .map_err(store_error)?;
        let index = SessionKey::new(session.account_did, session.session_id);
        self.db
            .lock()
            .map_err(|_| store_error(anyhow::anyhow!("Account database lock poisoned")))?
            .set(
                &format!("oauth_index_v2:{}/{}", index.did, index.session_id),
                &serde_json::to_string(&index).map_err(|err| store_error(err.into()))?,
                None,
            )
            .map_err(store_error)
    }
    async fn delete_session<D: BosStr + Send + Sync>(
        &self,
        did: &Did<D>,
        session_id: &str,
    ) -> std::result::Result<(), SessionStoreError> {
        self.remove(&Self::session_key(did.as_str(), session_id))
            .map_err(store_error)?;
        self.remove(&format!("oauth_index_v2:{did}/{session_id}"))
            .map_err(store_error)
    }
    async fn get_auth_req_info(
        &self,
        state: &str,
    ) -> std::result::Result<Option<AuthRequestData>, SessionStoreError> {
        self.read(&format!("oauth_state_v2:{state}"))
            .map_err(store_error)
    }
    async fn save_auth_req_info(
        &self,
        info: &AuthRequestData,
    ) -> std::result::Result<(), SessionStoreError> {
        self.write(
            &format!("oauth_state_v2:{}", info.state),
            info,
            600.0,
            false,
        )
        .map_err(store_error)
    }
    async fn delete_auth_req_info(
        &self,
        state: &str,
    ) -> std::result::Result<(), SessionStoreError> {
        self.remove(&format!("oauth_state_v2:{state}"))
            .map_err(store_error)
    }
    async fn list_session_keys(&self) -> std::result::Result<Vec<SessionKey>, SessionStoreError> {
        self.keys().map_err(store_error)
    }
}

fn scope(strategy: OAuthScopeStrategy) -> String {
    let scopes = wisp_core::scopes::build_wisp_scopes(wisp_core::scopes::WISP_CLI_PERMISSION_SETS);
    match strategy {
        OAuthScopeStrategy::Granular => scopes.legacy,
        _ => scopes.preferred,
    }
}

fn client(
    store: Arc<OAuthStore>,
    resolver: Arc<EnvResolver>,
    port: u16,
    strategy: OAuthScopeStrategy,
) -> Result<Client> {
    let config = metadata(port, strategy)?;
    Ok(OAuthClient::new_with_shared(
        store,
        resolver,
        ClientData {
            config,
            keyset: None,
        },
    ))
}

fn metadata(port: u16, strategy: OAuthScopeStrategy) -> Result<AtprotoClientMetadata<SmolStr>> {
    let scope = scope(strategy);
    let redirect = format!("http://127.0.0.1:{port}/oauth/callback");
    let query = serde_html_form::to_string([
        ("redirect_uri", redirect.as_str()),
        ("scope", scope.as_str()),
    ])?;
    let mut config = AtprotoClientMetadata::new_localhost(
        Some(vec![Uri::parse(redirect).map_err(|(err, _)| err)?]),
        Some(Scopes::new(SmolStr::new(scope))?),
    );
    config.client_id = Uri::parse(format!("http://localhost?{query}")).map_err(|(err, _)| err)?;
    config.client_name = Some("Wisp CLI".into());
    config.client_uri = Some(Uri::parse("https://wisp.place").unwrap().to_owned());
    Ok(config)
}

pub async fn restore(
    store: Arc<OAuthStore>,
    resolver: Arc<EnvResolver>,
    did: &str,
    port: u16,
    strategy: OAuthScopeStrategy,
    status: &mut impl FnMut(&str),
) -> Result<Option<Session>> {
    let client = client(store.clone(), resolver, port, strategy.clone())?;
    for key in store
        .keys()?
        .into_iter()
        .filter(|key| key.did.as_str() == did)
    {
        let session = match client.restore(&key.did, key.session_id.as_str()).await {
            Ok(session) => session,
            Err(_) => continue,
        };
        if let Some(data) = store.get_session(&key.did, key.session_id.as_str()).await? {
            let missing = wisp_core::scopes::missing_capabilities(
                Some(data.scopes.as_str()),
                &wisp_core::scopes::wisp_cli_required_capabilities(),
            );
            if missing.is_empty() {
                return Ok(Some(session));
            }
            status(&format!(
                "Stored session is missing {} scope(s). Re-authenticating...",
                missing.len()
            ));
        }
    }
    Ok(None)
}

// Self-contained (fairy and fonts inlined): the listener closes after this one
// response, and login has to work offline.
const SUCCESS_HTML: &str = include_str!("oauth-success.html");

async fn callback(listener: &TcpListener) -> Result<CallbackParams> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut reader = BufReader::new((&mut stream).take(16 * 1024));
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            reader.read_line(&mut line),
        )
        .await??;
        if !line.ends_with('\n') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if method != "GET" || path != "/oauth/callback" {
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found").await?;
            continue;
        }
        let params = serde_html_form::from_str(query)?;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{SUCCESS_HTML}",
            SUCCESS_HTML.len()
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(params);
    }
}

pub async fn login(
    store: Arc<OAuthStore>,
    resolver: Arc<EnvResolver>,
    identifier: &str,
    target_did: Option<&str>,
    preferred_port: u16,
    status: &mut impl FnMut(&str),
) -> Result<(Session, OAuthScopeStrategy, u16)> {
    let listener = match TcpListener::bind(("127.0.0.1", preferred_port)).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            TcpListener::bind(("127.0.0.1", 0)).await?
        }
        Err(err) => return Err(err.into()),
    };
    let port = listener.local_addr()?.port();
    if port != preferred_port {
        status(&format!(
            "OAuth callback port {preferred_port} is unavailable. Using {port} for this login flow."
        ));
    }
    status(&format!("Starting OAuth flow for {identifier}..."));
    let mut strategy = OAuthScopeStrategy::Sets;
    loop {
        let client = client(store.clone(), resolver.clone(), port, strategy.clone())?;
        let opts = AuthorizeOptions {
            scopes: Scopes::new(SmolStr::new(scope(strategy.clone())))?,
            ..Default::default()
        };
        let url = match client.start_auth(identifier, opts).await {
            Ok(url) => url,
            Err(err) if strategy == OAuthScopeStrategy::Sets => {
                wisp_ui::warning(format!(
                    "Authorization server rejected the wisp.place permission sets ({err}). Falling back to granular scopes."
                ));
                strategy = OAuthScopeStrategy::Granular;
                continue;
            }
            Err(err) => return Err(err.into()),
        };
        status("Opening browser for authentication...");
        status(&format!("If browser does not open, visit: {url}"));
        if std::env::var("WISPCTL_NO_BROWSER").as_deref() != Ok("1") {
            let _ = webbrowser::open(&url);
        }
        let params = tokio::time::timeout(std::time::Duration::from_secs(300), callback(&listener))
            .await
            .map_err(|_| anyhow::anyhow!("OAuth callback timeout"))??;
        let session = client.callback(params).await?;
        let (did, id) = session.session_info().await;
        if target_did.is_some_and(|target| target != did.as_str()) {
            store.delete_session(&did, &id).await?;
            bail!(
                "Authenticated account {did} does not match the requested account {}",
                target_did.unwrap()
            );
        }
        let data = store
            .get_session(&did, &id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("OAuth session was not persisted"))?;
        let missing = wisp_core::scopes::missing_capabilities(
            Some(data.scopes.as_str()),
            &wisp_core::scopes::wisp_cli_required_capabilities(),
        );
        if !missing.is_empty() && strategy == OAuthScopeStrategy::Sets {
            wisp_ui::warning(
                "Authorization server ignored the wisp.place permission sets. Retrying with granular scopes...",
            );
            store.delete_session(&did, &id).await?;
            strategy = OAuthScopeStrategy::Granular;
            continue;
        }
        if let Some(first) = missing.first() {
            wisp_ui::warning(format!(
                "OAuth token is missing {} requested permission(s). First missing: {}",
                missing.len(),
                wisp_core::scopes::describe_capability(first)
            ));
        }
        return Ok((session, strategy, port));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> OAuthStore {
        OAuthStore::new(Arc::new(Mutex::new(
            AccountStore::open(":memory:").unwrap(),
        )))
    }
    #[derive(Default)]
    struct FakeSecrets {
        values: Mutex<std::collections::HashMap<String, String>>,
        refuse: AtomicBool,
    }
    impl Secrets for FakeSecrets {
        fn read(&self, key: &str) -> Option<String> {
            self.values.lock().unwrap().get(key).cloned()
        }
        fn write(&self, key: &str, value: &str) -> bool {
            if self.refuse.load(Ordering::Relaxed) {
                return false;
            }
            self.values.lock().unwrap().insert(key.into(), value.into());
            true
        }
        fn remove(&self, key: &str) {
            self.values.lock().unwrap().remove(key);
        }
    }
    fn fake_store() -> (OAuthStore, Arc<FakeSecrets>) {
        let secrets = Arc::new(FakeSecrets::default());
        let mut store = store();
        store.secrets = secrets.clone();
        (store, secrets)
    }
    #[test]
    fn refused_keychain_write_keeps_latest_session_in_sqlite() {
        let (store, secrets) = fake_store();
        let key = "oauth_session_v2:did:plc:test/id";
        store.write(key, &"old", 1209600.0, true).unwrap();
        secrets.refuse.store(true, Ordering::Relaxed);
        store.write(key, &"new", 1209600.0, true).unwrap();
        assert_eq!(store.read::<String>(key).unwrap().as_deref(), Some("new"));
        assert!(secrets.values.lock().unwrap().is_empty());
        assert!(store.warned.load(Ordering::Relaxed));
    }
    #[test]
    fn successful_keychain_write_clears_older_sqlite_copy() {
        let (store, secrets) = fake_store();
        let key = "oauth_session_v2:did:plc:test/id";
        store.write(key, &"local", 1209600.0, false).unwrap();
        store.write(key, &"secret", 1209600.0, true).unwrap();
        assert!(store.db.lock().unwrap().get(key).unwrap().is_none());
        assert_eq!(
            store.read::<String>(key).unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
    }
    #[test]
    fn deletion_clears_both_backends() {
        let (store, secrets) = fake_store();
        let key = "oauth_session_v2:did:plc:test/id";
        store.write(key, &"secret", 1209600.0, true).unwrap();
        store
            .db
            .lock()
            .unwrap()
            .set(key, "\"local\"", None)
            .unwrap();
        store.remove(key).unwrap();
        assert!(store.read::<String>(key).unwrap().is_none());
        assert!(secrets.values.lock().unwrap().is_empty());
    }
    #[test]
    fn fallback_storage_expires_and_does_not_touch_legacy_entries() {
        let (store, _) = fake_store();
        store
            .db
            .lock()
            .unwrap()
            .set("oauth_session:did:plc:test", "legacy", None)
            .unwrap();
        store
            .write("oauth_state_v2:test", &"pending", 600.0, false)
            .unwrap();
        assert_eq!(
            store
                .read::<String>("oauth_state_v2:test")
                .unwrap()
                .as_deref(),
            Some("pending")
        );
        store
            .write("oauth_state_v2:test", &"expired", -1.0, false)
            .unwrap();
        assert!(
            store
                .read::<String>("oauth_state_v2:test")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .get("oauth_session:did:plc:test")
                .unwrap()
                .as_deref(),
            Some("legacy")
        );
    }
    #[test]
    fn strategy_declares_only_its_own_scopes_in_client_id() {
        for strategy in [OAuthScopeStrategy::Sets, OAuthScopeStrategy::Granular] {
            let requested = scope(strategy.clone());
            let config = metadata(4000, strategy).unwrap();
            let id = config.client_id.as_str();
            assert!(id.starts_with("http://localhost?"));
            assert!(id.contains("redirect_uri="));
            assert_eq!(config.scopes.as_str(), requested);
        }
    }
    #[tokio::test]
    async fn callback_ignores_other_paths_and_decodes_parameters() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            for target in [
                "/favicon.ico",
                "/oauth/callback?code=test%2Bcode&state=test&iss=http%3A%2F%2Flocalhost%3A3300",
            ] {
                let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
                stream
                    .write_all(
                        format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes(),
                    )
                    .await
                    .unwrap();
                let mut body = String::new();
                stream.read_to_string(&mut body).await.unwrap();
                assert!(body.starts_with(if target == "/favicon.ico" {
                    "HTTP/1.1 404"
                } else {
                    "HTTP/1.1 200"
                }));
            }
        });
        let params = callback(&listener).await.unwrap();
        assert_eq!(params.code.as_str(), "test+code");
        assert_eq!(params.state.as_deref(), Some("test"));
        assert_eq!(params.iss.as_deref(), Some("http://localhost:3300"));
        client.await.unwrap();
    }
    #[test]
    fn success_page_loads_nothing_from_the_network() {
        assert!(SUCCESS_HTML.contains("<svg"));
        for remote in ["<link", "src=\"http", "url(http"] {
            assert!(!SUCCESS_HTML.contains(remote), "{remote}");
        }
    }
}
