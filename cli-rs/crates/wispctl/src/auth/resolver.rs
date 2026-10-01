//! Environment-aware identity resolution using Jacquard's HTTP stack.
use super::store::{AccountStore, AccountUpdates, normalize_handle};
use anyhow::{Context, Result, anyhow};
use jacquard::{
    BosStr, IntoStatic,
    deps::fluent_uri::Uri,
    http_client::HttpClient,
    identity::{
        PublicResolver,
        resolver::{DidDocResponse, IdentityError, IdentityResolver, PlcSource, ResolverOptions},
    },
    oauth::{dpop::DpopExt, resolver::OAuthResolver},
    types::string::{Did, Handle},
};
use wisp_core::identity::{is_loopback_host, validate_pds_endpoint};

/// The TS CLI resolved handles only through this endpoint (then checked the
/// DID document), so CI egress allowlists name it rather than DNS/well-known.
const HANDLE_RESOLVER: &str =
    "https://slingshot.microcosm.blue/xrpc/com.atproto.identity.resolveHandle";

#[derive(Clone)]
pub struct EnvResolver {
    /// PDS traffic. No total timeout: a large blob upload takes as long as the
    /// link needs, as it did with the TS CLI.
    http: reqwest::Client,
    /// Identity lookups, which are small and bounded.
    identity: reqwest::Client,
    inner: PublicResolver,
    handle_url: String,
}

pub fn resolver() -> Result<EnvResolver> {
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let identity = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let mut opts = ResolverOptions::default();
    if let Ok(url) = std::env::var("WISP_PLC_DIRECTORY_URL") {
        opts.plc_source = PlcSource::PlcDirectory {
            base: Uri::parse(format!("{}/", url.trim_end_matches('/'))).map_err(|(err, _)| err)?,
        };
    }
    let inner = PublicResolver::new(identity.clone(), opts);
    Ok(EnvResolver {
        http,
        identity,
        inner,
        handle_url: std::env::var("WISP_HANDLE_RESOLVER_URL")
            .unwrap_or_else(|_| HANDLE_RESOLVER.to_owned()),
    })
}

fn allow_localhost() -> bool {
    std::env::var("WISP_ALLOW_LOCALHOST_FETCH").as_deref() == Ok("1")
}

impl HttpClient for EnvResolver {
    type Error = reqwest::Error;
    async fn send_http(
        &self,
        request: http::Request<Vec<u8>>,
    ) -> std::result::Result<http::Response<Vec<u8>>, Self::Error> {
        self.http.send_http(request).await
    }
}

impl IdentityResolver for EnvResolver {
    fn options(&self) -> &ResolverOptions {
        self.inner.options()
    }
    async fn resolve_handle<S: BosStr + Sync>(
        &self,
        handle: &Handle<S>,
    ) -> jacquard::identity::resolver::Result<Did> {
        let response = self
            .identity
            .get(&self.handle_url)
            .query(&[("handle", handle.as_str())])
            .send()
            .await
            .map_err(|err| IdentityError::transport("handle resolver request failed".into(), err))?
            .error_for_status()
            .map_err(|err| {
                IdentityError::transport("handle resolver rejected request".into(), err)
            })?;
        #[derive(serde::Deserialize)]
        struct Answer {
            did: Did,
        }
        let did = serde_json::from_slice::<Answer>(&bounded_body(response).await?)
            .map(|answer| answer.did)
            .map_err(|err| {
                IdentityError::transport("invalid handle resolver response".into(), err)
            })?;
        // Bidirectional check, as the TS CLI did: the DID must claim the handle.
        let doc = self.resolve_did_doc(&did).await?.into_owned()?;
        if doc
            .handles()
            .iter()
            .any(|claimed| claimed.as_str().eq_ignore_ascii_case(handle.as_str()))
        {
            Ok(did)
        } else {
            Err(IdentityError::handle_resolution_exhausted()
                .with_context("the DID document does not list this handle"))
        }
    }
    async fn resolve_did_doc<S: BosStr + Sync>(
        &self,
        did: &Did<S>,
    ) -> jacquard::identity::resolver::Result<DidDocResponse> {
        if allow_localhost()
            && let Some(url) = local_web_url(did.as_str())
        {
            let response =
                self.identity.get(url).send().await.map_err(|err| {
                    IdentityError::transport("local DID request failed".into(), err)
                })?;
            let status = response.status();
            let headers = response.headers().clone();
            let buffer = bounded_body(response).await?;
            return Ok(DidDocResponse {
                buffer,
                status,
                headers,
                requested: Some(did.borrow().into_static()),
            });
        }
        self.inner.resolve_did_doc(did).await
    }
}
impl OAuthResolver for EnvResolver {}
impl DpopExt for EnvResolver {}

/// Handle or DID → (DID, PDS endpoint), failing with the TS CLI's messages.
pub async fn resolve_identity(identifier: &str) -> Result<(String, String)> {
    let resolver = resolver()?;
    let did = if identifier.starts_with("did:") {
        Did::new(identifier)?.into_static()
    } else {
        let handle = Handle::new(normalize_handle(identifier))
            .map_err(|_| anyhow!("Failed to resolve handle"))?;
        resolver
            .resolve_handle(&handle)
            .await
            .map_err(|_| anyhow!("Failed to resolve handle"))?
    };
    let doc = match resolver.resolve_did_doc(&did).await {
        Ok(response) => Some(response.into_owned()?),
        Err(_) => None,
    };
    let pds = doc
        .as_ref()
        .and_then(|doc| doc.pds_endpoint())
        .and_then(|pds| validate_pds_endpoint(pds.as_str(), allow_localhost()))
        .context("Could not find a valid PDS endpoint")?;
    Ok((did.to_string(), pds))
}

pub async fn resolve_identifier_to_did(
    store: &AccountStore,
    identifier: &str,
) -> Result<Option<String>> {
    let cached = store.cached_identifier(identifier)?;
    if identifier.starts_with("did:") {
        return Ok(cached);
    }
    let normalized = normalize_handle(identifier);
    if let Some(did) = &cached
        && store.alias_is_fresh(did, &normalized)?
    {
        return Ok(cached);
    }
    let did = match resolver()?
        .resolve_handle(&Handle::new(normalized.as_str())?)
        .await
    {
        Ok(did) => did.to_string(),
        Err(_) => return Ok(cached),
    };
    if let Some(previous) = &cached
        && previous != &did
    {
        store.detach_handle(previous, &normalized)?;
    }
    if store.get_account(&did)?.is_some() {
        store.upsert_account(
            &did,
            &AccountUpdates {
                handle: Some(normalized.clone()),
                handle_checked: true,
                ..Default::default()
            },
        )?;
    }
    store.set(&format!("handle:{normalized}"), &did, None)?;
    Ok(Some(did))
}

pub async fn backfill_handle(store: &AccountStore, did: &str) -> Result<Option<String>> {
    if let Some(handle) = store.get_account(did)?.and_then(|a| a.handle) {
        return Ok(Some(handle));
    }
    let handle = verified_handle(did).await?;
    if let Some(handle) = &handle {
        store.upsert_account(
            did,
            &AccountUpdates {
                handle: Some(handle.clone()),
                handle_checked: true,
                ..Default::default()
            },
        )?;
    }
    Ok(handle)
}

pub async fn verified_handle(did: &str) -> Result<Option<String>> {
    let resolver = resolver()?;
    let doc = match resolver.resolve_did_doc(&Did::new(did)?).await {
        Ok(response) => response.into_owned()?,
        Err(_) => return Ok(None),
    };
    for handle in doc.handles() {
        if resolver
            .resolve_handle(&handle)
            .await
            .is_ok_and(|resolved| resolved.as_str() == did)
        {
            return Ok(Some(handle.to_string()));
        }
    }
    Ok(None)
}

fn local_web_url(did: &str) -> Option<reqwest::Url> {
    let authority = did
        .strip_prefix("did:web:")?
        .replace("%3A", ":")
        .replace("%3a", ":");
    let url = reqwest::Url::parse(&format!("http://{authority}/.well-known/did.json")).ok()?;
    is_loopback_host(&url).then_some(url)
}

#[allow(
    clippy::result_large_err,
    reason = "the identity resolver's own error type, returned as-is to its callers"
)]
async fn bounded_body(
    mut response: reqwest::Response,
) -> jacquard::identity::resolver::Result<jacquard::deps::bytes::Bytes> {
    const LIMIT: usize = 1024 * 1024;
    let read = async {
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|err| IdentityError::transport("identity response failed".into(), err))?
        {
            if bytes.len() + chunk.len() > LIMIT {
                return Err(IdentityError::transport(
                    "identity response too large".into(),
                    std::io::Error::other("identity response exceeds 1 MiB"),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes.into())
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), read)
        .await
        .map_err(|err| IdentityError::transport("identity response timed out".into(), err))?
}
