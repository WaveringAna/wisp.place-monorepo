//! Authenticated, typed calls through the wisp service proxy.

use crate::{
    auth::{self, AuthOptions, WispAgent},
    cli::XrpcOptions,
    prompts,
};
use anyhow::{Context, Result, bail};
use jacquard::xrpc::{CallOptions, XrpcClient, XrpcRequest, XrpcResp};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use wispplace_core::constants::{DEFAULT_WISP_SERVICE_DID, WISP_PROXY_SERVICE_ID};

pub async fn resolve_identity(identifier: &str) -> Result<(String, String)> {
    auth::resolver::resolve_identity(identifier).await
}

pub fn parse_service_did(input: Option<&str>) -> Result<String> {
    let value = input.map(str::trim).filter(|s| !s.is_empty());
    let Some(value) = value else {
        return Ok(DEFAULT_WISP_SERVICE_DID.to_owned());
    };
    let result = if let Some(rest) = value.strip_prefix("did:") {
        let valid = !value.contains('#')
            && !value.chars().any(char::is_whitespace)
            && rest
                .split_once(':')
                .is_some_and(|(method, id)| !method.is_empty() && !id.is_empty());
        valid.then(|| value.to_owned())
    } else {
        let valid = !value.contains('#')
            && !value.chars().any(char::is_whitespace)
            && !value.contains('/')
            && !value.contains('\\');
        valid.then(|| format!("did:web:{}", value.replace(':', "%3A")))
    };
    result.ok_or_else(|| anyhow::anyhow!("Invalid --service value \"{value}\". Expected did:..."))
}

fn swallowed_handle(handle: Option<&str>, password: Option<&str>) -> bool {
    let Some(password) = password.filter(|_| handle.is_none()) else {
        return false;
    };
    password.contains('.')
        && password
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

fn spinner_text(message: &str) -> String {
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 120 {
        compact
    } else {
        format!("{}...", compact.chars().take(119).collect::<String>())
    }
}

pub fn bind_auth_status(spinner: &mut wispplace_ui::Spinner, message: &str) {
    if message.starts_with("If browser does not open, visit: ") {
        spinner.set_text("Waiting for OAuth callback...");
        wispplace_ui::note(message.to_owned());
    } else {
        spinner.set_text(spinner_text(message));
    }
}

pub async fn authenticate_for_xrpc(
    handle: Option<&str>,
    options: &XrpcOptions,
) -> Result<(WispAgent, String, String)> {
    if swallowed_handle(handle, options.password.as_deref()) {
        bail!(
            "`--password` appears to have consumed the handle argument. Provide a password value and pass the handle separately."
        );
    }
    let known = if handle.is_none() && options.password.is_none() {
        auth::resolve_account_for_cwd(options.db.db.as_deref()).await
    } else {
        None
    };
    let prompted = if handle.is_none() && known.is_none() {
        Some(prompts::handle("Command cancelled")?)
    } else {
        None
    };
    let identifier = handle.or(prompted.as_deref());
    let service = parse_service_did(options.service.as_deref())?;
    let mut spinner = wispplace_ui::spinner("Authenticating...");
    let authenticated = auth::authenticate(
        identifier,
        &AuthOptions {
            app_password: options.password.clone(),
            db_path: options.db.db.clone(),
            force_reauth: false,
        },
        |message| bind_auth_status(&mut spinner, message),
    )
    .await?;
    let label = identifier
        .or_else(|| known.as_ref().and_then(|a| a.handle.as_deref()))
        .unwrap_or(&authenticated.did);
    spinner.succeed(format!("Authenticated as {label}"));
    Ok((authenticated.agent, service, authenticated.did))
}

pub async fn call<R>(agent: &WispAgent, service: &str, request: Value) -> Result<Value>
where
    R: XrpcRequest + Serialize + DeserializeOwned + Send + Sync,
    R::Response: Send + Sync,
    <R::Response as XrpcResp>::Output<String>: DeserializeOwned,
{
    send(agent, service, serde_json::from_value::<R>(request)?, None).await
}

pub async fn send<R>(
    agent: &WispAgent,
    service: &str,
    request: R,
    content_type: Option<&str>,
) -> Result<Value>
where
    R: XrpcRequest + Serialize + Send + Sync,
    R::Response: Send + Sync,
    <R::Response as XrpcResp>::Output<String>: DeserializeOwned,
{
    let mut opts = CallOptions {
        atproto_proxy: Some(format!("{service}#{WISP_PROXY_SERVICE_ID}").into()),
        ..Default::default()
    };
    if let Some(content_type) = content_type {
        opts.extra_headers
            .push((http::header::CONTENT_TYPE, content_type.parse()?));
    }
    let response = agent.send_with_opts(request, opts).await.with_context(|| {
        format!(
            "request via service {service} failed; if this is not the service you meant, set --service or WISPCTL_SERVICE"
        )
    })?;
    // Decode the generated output before returning the original JSON to renderers.
    response
        .parse::<String>()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(serde_json::from_slice(response.buffer())?)
}

pub fn json(data: &Value) -> Result<()> {
    wispplace_ui::out_text(&serde_json::to_string_pretty(data)?);
    Ok(())
}

pub fn text<'a>(data: &'a Value, key: &str) -> &'a str {
    data[key].as_str().unwrap_or("")
}
pub fn items<'a>(data: &'a Value, key: &str) -> &'a [Value] {
    data[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_did_validation_matches_typescript() {
        for valid in [
            None,
            Some(""),
            Some(" did:web:localhost%3A8000 "),
            Some("did:plc:abc"),
            Some("localhost:8000"),
            Some("wisp.place"),
        ] {
            assert!(parse_service_did(valid).is_ok());
        }
        for invalid in [
            "https://wisp.place",
            "did::abc",
            "did:web:",
            "did:web:x#proxy",
            "did:web:x y",
            "#bad",
            "local host",
        ] {
            assert!(parse_service_did(Some(invalid)).is_err());
        }
    }
    #[test]
    fn auth_status_is_compact_and_unicode_safe() {
        assert_eq!(spinner_text(" a\n b "), "a b");
        assert_eq!(
            spinner_text(&"é".repeat(121)),
            format!("{}...", "é".repeat(119))
        );
        assert!(swallowed_handle(None, Some("alice.test")));
        assert!(!swallowed_handle(Some("alice.test"), Some("alice.test")));
        assert!(!swallowed_handle(None, Some("aaaa-bbbb-cccc-dddd")));
    }
}
