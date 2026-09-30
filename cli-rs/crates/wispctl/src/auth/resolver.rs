//! Environment-aware identity resolution using Jacquard's HTTP stack.
use super::store::{AccountStore, AccountUpdates, normalize_handle};
use anyhow::{Context, Result, bail};
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

#[derive(Clone)]
pub struct EnvResolver {
    http: reqwest::Client,
    inner: PublicResolver,
    handle_url: Option<String>,
}

pub fn resolver() -> Result<EnvResolver> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let mut opts = ResolverOptions::default();
    if let Ok(url) = std::env::var("WISP_PLC_DIRECTORY_URL") {
        opts.plc_source = PlcSource::PlcDirectory {
            base: Uri::parse(format!("{}/", url.trim_end_matches('/'))).map_err(|(err, _)| err)?,
        };
    }
    let inner = PublicResolver::new(http.clone(), opts).with_system_dns();
    Ok(EnvResolver {
        http,
        inner,
        handle_url: std::env::var("WISP_HANDLE_RESOLVER_URL").ok(),
    })
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
        if let Some(url) = &self.handle_url {
            let response = self
                .http
                .get(url)
                .query(&[("handle", handle.as_str())])
                .send()
                .await
                .map_err(|err| {
                    IdentityError::transport("handle resolver request failed".into(), err)
                })?
                .error_for_status()
                .map_err(|err| {
                    IdentityError::transport("handle resolver rejected request".into(), err)
                })?;
            #[derive(serde::Deserialize)]
            struct Answer {
                did: Did,
            }
            return serde_json::from_slice::<Answer>(&bounded_body(response).await?)
                .map(|answer| answer.did)
                .map_err(|err| {
                    IdentityError::transport("invalid handle resolver response".into(), err)
                });
        }
        self.inner.resolve_handle(handle).await
    }
    async fn resolve_did_doc<S: BosStr + Sync>(
        &self,
        did: &Did<S>,
    ) -> jacquard::identity::resolver::Result<DidDocResponse> {
        if std::env::var("WISP_ALLOW_LOCALHOST_FETCH").as_deref() == Ok("1")
            && let Some(url) = local_web_url(did.as_str())
        {
            let response =
                self.http.get(url).send().await.map_err(|err| {
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

pub async fn resolve_identity(identifier: &str) -> Result<(String, String)> {
    let resolver = resolver()?;
    let did = if identifier.starts_with("did:") {
        Did::new(identifier)?.into_static()
    } else {
        resolver
            .resolve_handle(&Handle::new(normalize_handle(identifier))?)
            .await?
    };
    let doc = resolver.resolve_did_doc(&did).await?.into_owned()?;
    let pds = doc
        .pds_endpoint()
        .context("DID document has no PDS endpoint")?;
    let url = reqwest::Url::parse(pds.as_str())?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && is_loopback(&url)
            && std::env::var("WISP_ALLOW_LOCALHOST_FETCH").as_deref() == Ok("1"))
    {
        bail!("HTTP PDS requires a loopback host and WISP_ALLOW_LOCALHOST_FETCH=1");
    }
    Ok((did.to_string(), pds.to_string()))
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

fn is_loopback(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}
fn local_web_url(did: &str) -> Option<reqwest::Url> {
    let authority = did
        .strip_prefix("did:web:")?
        .replace("%3A", ":")
        .replace("%3a", ":");
    let url = reqwest::Url::parse(&format!("http://{authority}/.well-known/did.json")).ok()?;
    is_loopback(&url).then_some(url)
}

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
