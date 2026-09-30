//! Authentication shared by deploy and the service commands.
pub mod keychain;
pub mod oauth;
pub mod resolver;
pub mod store;

use anyhow::{Context, Result, bail};
use jacquard::client::credential_session::{CredentialSession, SessionKey};
use jacquard::{
    AuthorizationToken, BosStr, SmolStr,
    client::{Agent, AgentKind, AgentSession, AtpSession, ClientResult, MemorySessionStore},
    deps::fluent_uri::Uri,
    http_client::HttpClient,
    identity::resolver::{DidDocResponse, IdentityResolver, ResolverOptions},
    types::string::{Did, Handle},
    xrpc::{CallOptions, XrpcClient, XrpcRequest, XrpcResponse},
};
use resolver::EnvResolver;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use store::{AccountStore, AccountUpdates, AuthMethod, OAuthScopeStrategy, StoredAccount};

#[derive(Clone, Debug, Default)]
pub struct AuthOptions {
    pub app_password: Option<String>,
    pub db_path: Option<PathBuf>,
    pub force_reauth: bool,
}

pub type WispAgent = Agent<WispSession>;
pub struct Authenticated {
    pub agent: WispAgent,
    pub did: String,
    pub handle: Option<String>,
}

type PasswordSession = CredentialSession<MemorySessionStore<SessionKey, AtpSession>, EnvResolver>;
#[derive(Clone)]
pub enum WispSession {
    OAuth(oauth::Session),
    Credential(Arc<PasswordSession>),
}

impl HttpClient for WispSession {
    type Error = reqwest::Error;
    async fn send_http(
        &self,
        request: http::Request<Vec<u8>>,
    ) -> std::result::Result<http::Response<Vec<u8>>, Self::Error> {
        match self {
            Self::OAuth(session) => session.send_http(request).await,
            Self::Credential(session) => session.send_http(request).await,
        }
    }
}

impl XrpcClient for WispSession {
    async fn base_uri(&self) -> Uri<String> {
        match self {
            Self::OAuth(session) => session.base_uri().await,
            Self::Credential(session) => session.base_uri().await,
        }
    }
    async fn set_base_uri(&self, uri: Uri<String>) -> () {
        match self {
            Self::OAuth(session) => session.set_base_uri(uri).await,
            Self::Credential(session) => session.set_base_uri(uri).await,
        }
    }
    async fn opts(&self) -> CallOptions {
        match self {
            Self::OAuth(session) => session.opts().await,
            Self::Credential(session) => session.opts().await,
        }
    }
    async fn set_opts(&self, opts: CallOptions) -> () {
        match self {
            Self::OAuth(session) => session.set_opts(opts).await,
            Self::Credential(session) => session.set_opts(opts).await,
        }
    }
    async fn send<R>(&self, request: R) -> jacquard::error::XrpcResult<XrpcResponse<R>>
    where
        R: XrpcRequest + Send + Sync + Serialize,
        R::Response: Send + Sync,
    {
        match self {
            Self::OAuth(session) => session.send(request).await,
            Self::Credential(session) => session.send(request).await,
        }
    }
    async fn send_with_opts<R>(
        &self,
        request: R,
        opts: CallOptions,
    ) -> jacquard::error::XrpcResult<XrpcResponse<R>>
    where
        R: XrpcRequest + Send + Sync + Serialize,
        R::Response: Send + Sync,
    {
        match self {
            Self::OAuth(session) => session.send_with_opts(request, opts).await,
            Self::Credential(session) => session.send_with_opts(request, opts).await,
        }
    }
}
impl AgentSession for WispSession {
    fn session_kind(&self) -> AgentKind {
        match self {
            Self::OAuth(_) => AgentKind::OAuth,
            Self::Credential(_) => AgentKind::AppPassword,
        }
    }
    async fn session_info(&self) -> Option<(Did, Option<SmolStr>)> {
        match self {
            Self::OAuth(session) => AgentSession::session_info(session).await,
            Self::Credential(session) => AgentSession::session_info(session.as_ref()).await,
        }
    }
    async fn endpoint(&self) -> Uri<String> {
        match self {
            Self::OAuth(session) => AgentSession::endpoint(session).await,
            Self::Credential(session) => AgentSession::endpoint(session.as_ref()).await,
        }
    }
    async fn set_options(&self, opts: CallOptions) -> () {
        match self {
            Self::OAuth(session) => AgentSession::set_options(session, opts).await,
            Self::Credential(session) => AgentSession::set_options(session.as_ref(), opts).await,
        }
    }
    async fn refresh(&self) -> ClientResult<AuthorizationToken<SmolStr>> {
        match self {
            Self::OAuth(session) => AgentSession::refresh(session).await,
            Self::Credential(session) => AgentSession::refresh(session.as_ref()).await,
        }
    }
}
impl IdentityResolver for WispSession {
    fn options(&self) -> &ResolverOptions {
        match self {
            Self::OAuth(s) => s.options(),
            Self::Credential(s) => s.options(),
        }
    }
    async fn resolve_handle<S: BosStr + Sync>(
        &self,
        value: &Handle<S>,
    ) -> jacquard::identity::resolver::Result<Did> {
        match self {
            Self::OAuth(s) => s.resolve_handle(value).await,
            Self::Credential(s) => s.resolve_handle(value).await,
        }
    }
    async fn resolve_did_doc<S: BosStr + Sync>(
        &self,
        value: &Did<S>,
    ) -> jacquard::identity::resolver::Result<DidDocResponse> {
        match self {
            Self::OAuth(s) => s.resolve_did_doc(value).await,
            Self::Credential(s) => s.resolve_did_doc(value).await,
        }
    }
}

fn open_store(db: Option<&Path>) -> Result<AccountStore> {
    match db {
        Some(path) => AccountStore::open(path),
        None => AccountStore::open_default(),
    }
}

pub async fn resolve_account_for_cwd(db: Option<&Path>) -> Result<Option<StoredAccount>> {
    open_store(db)?.resolve_account_for_dir(&std::env::current_dir()?.to_string_lossy())
}

async fn password_session(
    identifier: &str,
    password: &str,
    pds: Option<&str>,
    resolver: Arc<EnvResolver>,
    status: &mut impl FnMut(&str),
) -> Result<(WispSession, String, String, Option<String>)> {
    let pds = match pds {
        Some(pds) => pds.to_owned(),
        None => {
            status(&format!("Resolving PDS for {identifier}..."));
            let (_, pds) = self::resolver::resolve_identity(identifier).await?;
            status(&format!("Found PDS: {pds}"));
            pds
        }
    };
    let session = CredentialSession::new(Arc::new(MemorySessionStore::default()), resolver);
    let data = session
        .login(
            identifier,
            password,
            None,
            None,
            None,
            Some(Uri::parse(pds.clone()).map_err(|(err, _)| err)?),
        )
        .await?;
    let did = data.did.to_string();
    let handle = Some(data.handle.to_string());
    status(&format!("Authenticated as {did}"));
    Ok((WispSession::Credential(Arc::new(session)), did, pds, handle))
}

async fn finish(
    db: &Arc<Mutex<AccountStore>>,
    session: WispSession,
    did: String,
    handle: Option<String>,
    updates: AccountUpdates,
    cwd: &str,
) -> Result<Authenticated> {
    {
        let store = db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?;
        store.upsert_account(
            &did,
            &AccountUpdates {
                handle: handle.clone(),
                handle_checked: handle.is_some(),
                ..updates
            },
        )?;
        store.set_dir(cwd, &did)?;
    }
    // Do not hold a SQLite lock across network I/O.
    let handle = if handle.is_some() {
        handle
    } else {
        let found = resolver::verified_handle(&did).await?;
        if let Some(handle) = &found {
            db.lock()
                .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
                .upsert_account(
                    &did,
                    &AccountUpdates {
                        handle: Some(handle.clone()),
                        handle_checked: true,
                        ..Default::default()
                    },
                )?;
        }
        found
    };
    Ok(Authenticated {
        agent: Agent::new(session),
        did,
        handle,
    })
}

pub async fn authenticate(
    handle: Option<&str>,
    opts: &AuthOptions,
    mut on_status: impl FnMut(&str),
) -> Result<Authenticated> {
    let db = Arc::new(Mutex::new(open_store(opts.db_path.as_deref())?));
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let normalized = handle.map(|h| {
        if h.starts_with("did:") {
            h.to_owned()
        } else {
            store::normalize_handle(h)
        }
    });
    let identifier = normalized.as_deref();
    let password = match opts.app_password.as_deref() {
        Some(password) => {
            if password.trim().is_empty() {
                bail!("App password is required when using --password");
            }
            if identifier.is_none() {
                bail!("Handle required with app password authentication");
            }
            Some(password.trim().to_owned())
        }
        None if identifier.is_some() => std::env::var("WISPCTL_APP_PASSWORD")
            .ok()
            .filter(|p| !p.trim().is_empty())
            .map(|p| p.trim().to_owned()),
        None => None,
    };
    let resolver = Arc::new(resolver::resolver()?);
    if let Some(password) = password {
        let (session, did, pds, session_handle) = password_session(
            identifier.unwrap(),
            &password,
            None,
            resolver,
            &mut on_status,
        )
        .await?;
        return finish(
            &db,
            session,
            did,
            session_handle,
            AccountUpdates {
                method: Some(AuthMethod::AppPassword),
                pds_url: Some(pds),
                ..Default::default()
            },
            &cwd,
        )
        .await;
    }
    let target_did = match identifier {
        Some(value) => {
            let lookup = open_store(opts.db_path.as_deref())?;
            resolver::resolve_identifier_to_did(&lookup, value).await?
        }
        None => db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
            .resolve_account_for_dir(&cwd)?
            .map(|account| account.did),
    };
    let account = match &target_did {
        Some(did) => db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
            .get_account(did)?,
        None => None,
    };
    let store = Arc::new(oauth::OAuthStore::new(db.clone()));
    let port_key = format!("dir_oauth_port:{cwd}");
    let port = db
        .lock()
        .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?
        .get(&port_key)?
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(4000);
    if !opts.force_reauth
        && let Some(did) = &target_did
    {
        let label = account
            .as_ref()
            .and_then(|a| a.handle.as_deref())
            .unwrap_or(did);
        let methods = if account
            .as_ref()
            .is_some_and(|a| a.method == AuthMethod::AppPassword)
        {
            [AuthMethod::AppPassword, AuthMethod::OAuth]
        } else {
            [AuthMethod::OAuth, AuthMethod::AppPassword]
        };
        for method in methods {
            match method {
                AuthMethod::OAuth => {
                    let strategy = account
                        .as_ref()
                        .and_then(|a| a.oauth_scope.clone())
                        .unwrap_or(OAuthScopeStrategy::Sets);
                    if let Ok(Some(session)) = oauth::restore(
                        store.clone(),
                        resolver.clone(),
                        did,
                        port,
                        strategy.clone(),
                        &mut on_status,
                    )
                    .await
                    {
                        on_status(&format!("Restored session for {label}"));
                        return finish(
                            &db,
                            WispSession::OAuth(session),
                            did.clone(),
                            account.as_ref().and_then(|a| a.handle.clone()),
                            AccountUpdates {
                                method: Some(AuthMethod::OAuth),
                                oauth_scope: Some(strategy),
                                ..Default::default()
                            },
                            &cwd,
                        )
                        .await;
                    }
                }
                AuthMethod::AppPassword => {
                    if let Some(password) = keychain::get_stored_app_password(did) {
                        let identifier = account
                            .as_ref()
                            .and_then(|a| a.handle.as_deref())
                            .unwrap_or(did);
                        let pds = account.as_ref().and_then(|a| a.pds_url.as_deref());
                        match password_session(
                            identifier,
                            &password,
                            pds,
                            resolver.clone(),
                            &mut |_| {},
                        )
                        .await
                        {
                            Ok((session, actual, pds, handle)) if &actual == did => {
                                on_status(&format!("Restored app password session for {label}"));
                                return finish(
                                    &db,
                                    session,
                                    actual,
                                    handle,
                                    AccountUpdates {
                                        method: Some(AuthMethod::AppPassword),
                                        pds_url: Some(pds),
                                        ..Default::default()
                                    },
                                    &cwd,
                                )
                                .await;
                            }
                            Ok((_, actual, _, _)) => wisp_ui::warning(format!(
                                "Stored app password authenticated as {actual}, expected {did}; ignoring it."
                            )),
                            Err(_) => wisp_ui::warning(format!(
                                "Stored app password for {label} was rejected."
                            )),
                        }
                    }
                }
            }
        }
    }
    let identifier = identifier
        .or(target_did.as_deref())
        .context("No stored account. Run `wispctl login <handle>` first.")?;
    let (session, strategy, port) = oauth::login(
        store,
        resolver,
        identifier,
        target_did.as_deref(),
        port,
        &mut on_status,
    )
    .await?;
    let (did, _) = session.session_info().await;
    {
        let store = db
            .lock()
            .map_err(|_| anyhow::anyhow!("Account database lock poisoned"))?;
        if port == 4000 {
            store.delete(&port_key)?;
        } else {
            store.set(&port_key, &port.to_string(), None)?;
        }
    }
    on_status(&format!("Authenticated as {did}"));
    let handle = normalized.filter(|handle| !handle.starts_with("did:"));
    finish(
        &db,
        WispSession::OAuth(session),
        did.to_string(),
        handle,
        AccountUpdates {
            method: Some(AuthMethod::OAuth),
            oauth_scope: Some(strategy),
            ..Default::default()
        },
        &cwd,
    )
    .await
}
