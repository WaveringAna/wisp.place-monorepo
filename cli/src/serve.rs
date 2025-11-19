use crate::pull::pull_site;
use crate::redirects::{load_redirect_rules, match_redirect_rule, RedirectRule};
use axum::{
    Router,
    extract::Request,
    response::{Response, IntoResponse, Redirect},
    http::{StatusCode, Uri},
};
use jacquard::CowStr;
use jacquard::api::com_atproto::sync::subscribe_repos::{SubscribeRepos, SubscribeReposMessage};
use jacquard_common::types::string::Did;
use jacquard_common::xrpc::{SubscriptionClient, TungsteniteSubscriptionClient};
use miette::IntoDiagnostic;
use n0_future::StreamExt;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower::Service;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;

/// Shared state for the server
#[derive(Clone)]
struct ServerState {
    did: CowStr<'static>,
    rkey: CowStr<'static>,
    output_dir: PathBuf,
    last_cid: Arc<RwLock<Option<String>>>,
    redirect_rules: Arc<RwLock<Vec<RedirectRule>>>,
}

/// Serve a site locally with real-time firehose updates
pub async fn serve_site(
    input: CowStr<'static>,
    rkey: CowStr<'static>,
    output_dir: PathBuf,
    port: u16,
) -> miette::Result<()> {
    println!("Serving site {} from {} on port {}...", rkey, input, port);

    // Resolve handle to DID if needed
    use jacquard_identity::PublicResolver;
    use jacquard::prelude::IdentityResolver;
    
    let resolver = PublicResolver::default();
    let did = if input.starts_with("did:") {
        Did::new(&input).into_diagnostic()?
    } else {
        // It's a handle, resolve it
        let handle = jacquard_common::types::string::Handle::new(&input).into_diagnostic()?;
        resolver.resolve_handle(&handle).await.into_diagnostic()?
    };
    
    println!("Resolved to DID: {}", did.as_str());

    // Create output directory if it doesn't exist
    std::fs::create_dir_all(&output_dir).into_diagnostic()?;

    // Initial pull of the site
    println!("Performing initial pull...");
    let did_str = CowStr::from(did.as_str().to_string());
    pull_site(did_str.clone(), rkey.clone(), output_dir.clone()).await?;

    // Load redirect rules
    let redirect_rules = load_redirect_rules(&output_dir);
    if !redirect_rules.is_empty() {
        println!("Loaded {} redirect rules from _redirects", redirect_rules.len());
    }

    // Create shared state
    let state = ServerState {
        did: did_str.clone(),
        rkey: rkey.clone(),
        output_dir: output_dir.clone(),
        last_cid: Arc::new(RwLock::new(None)),
        redirect_rules: Arc::new(RwLock::new(redirect_rules)),
    };

    // Start firehose listener in background
    let firehose_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = watch_firehose(firehose_state).await {
            eprintln!("Firehose error: {}", e);
        }
    });

    // Create HTTP server with gzip compression and redirect handling
    let serve_dir = ServeDir::new(&output_dir).precompressed_gzip();

    let app = Router::new()
        .fallback(move |req: Request| {
            let state = state.clone();
            let mut serve_dir = serve_dir.clone();
            async move {
                handle_request_with_redirects(req, state, &mut serve_dir).await
            }
        })
        .layer(CompressionLayer::new());

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .into_diagnostic()?;

    println!("\n✓ Server running at http://localhost:{}", port);
    println!("  Watching for updates on the firehose...\n");

    axum::serve(listener, app).await.into_diagnostic()?;

    Ok(())
}

/// Handle a request with redirect support
async fn handle_request_with_redirects(
    req: Request,
    state: ServerState,
    serve_dir: &mut ServeDir,
) -> Response {
    let uri = req.uri().clone();
    let path = uri.path();
    let method = req.method().clone();

    // Parse query parameters
    let query_params = uri.query().map(|q| {
        let mut params = HashMap::new();
        for pair in q.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                params.insert(key.to_string(), value.to_string());
            }
        }
        params
    });

    // Check for redirect rules
    let redirect_rules = state.redirect_rules.read().await;
    if let Some(redirect_match) = match_redirect_rule(path, &redirect_rules, query_params.as_ref()) {
        let is_force = redirect_match.force;
        drop(redirect_rules); // Release the lock

        // If not forced, check if the file exists first
        if !is_force {
            // Try to serve the file normally first
            let test_req = Request::builder()
                .uri(uri.clone())
                .method(&method)
                .body(axum::body::Body::empty())
                .unwrap();

            match serve_dir.call(test_req).await {
                Ok(response) if response.status().is_success() => {
                    // File exists and was served successfully, return it
                    return response.into_response();
                }
                _ => {
                    // File doesn't exist or error, apply redirect
                }
            }
        }

        // Handle different status codes
        match redirect_match.status {
            200 => {
                // Rewrite: serve the target file but keep the URL the same
                if let Ok(target_uri) = redirect_match.target_path.parse::<Uri>() {
                    let new_req = Request::builder()
                        .uri(target_uri)
                        .method(&method)
                        .body(axum::body::Body::empty())
                        .unwrap();

                    match serve_dir.call(new_req).await {
                        Ok(response) => response.into_response(),
                        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    }
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
            301 => {
                // Permanent redirect
                Redirect::permanent(&redirect_match.target_path).into_response()
            }
            302 => {
                // Temporary redirect
                Redirect::temporary(&redirect_match.target_path).into_response()
            }
            404 => {
                // Custom 404 page
                if let Ok(target_uri) = redirect_match.target_path.parse::<Uri>() {
                    let new_req = Request::builder()
                        .uri(target_uri)
                        .method(&method)
                        .body(axum::body::Body::empty())
                        .unwrap();

                    match serve_dir.call(new_req).await {
                        Ok(mut response) => {
                            *response.status_mut() = StatusCode::NOT_FOUND;
                            response.into_response()
                        }
                        Err(_) => StatusCode::NOT_FOUND.into_response(),
                    }
                } else {
                    StatusCode::NOT_FOUND.into_response()
                }
            }
            _ => {
                // Unsupported status code, fall through to normal serving
                match serve_dir.call(req).await {
                    Ok(response) => response.into_response(),
                    Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
        }
    } else {
        drop(redirect_rules);
        // No redirect match, serve normally
        match serve_dir.call(req).await {
            Ok(response) => response.into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        }
    }
}

/// Watch the firehose for updates to the specific site
fn watch_firehose(state: ServerState) -> std::pin::Pin<Box<dyn std::future::Future<Output = miette::Result<()>> + Send>> {
    Box::pin(async move {
    use jacquard_identity::PublicResolver;
    use jacquard::prelude::IdentityResolver;

    // Resolve DID to PDS URL
    let resolver = PublicResolver::default();
    let did = Did::new(&state.did).into_diagnostic()?;
    let pds_url = resolver.pds_for_did(&did).await.into_diagnostic()?;

    println!("[PDS] Resolved DID to PDS: {}", pds_url);

    // Convert HTTP(S) URL to WebSocket URL
    let mut ws_url = pds_url.clone();
    let scheme = if pds_url.scheme() == "https" { "wss" } else { "ws" };
    ws_url.set_scheme(scheme)
        .map_err(|_| miette::miette!("Failed to set WebSocket scheme"))?;

    println!("[PDS] Connecting to {}...", ws_url);

    // Create subscription client
    let client = TungsteniteSubscriptionClient::from_base_uri(ws_url);

    // Subscribe to the PDS firehose
    let params = SubscribeRepos::new().build();

    let stream = client.subscribe(&params).await.into_diagnostic()?;
    println!("[PDS] Connected! Watching for updates...");

    // Convert to typed message stream
    let (_sink, mut messages) = stream.into_stream();

    loop {
        match messages.next().await {
            Some(Ok(msg)) => {
                if let Err(e) = handle_firehose_message(&state, msg).await {
                    eprintln!("[PDS] Error handling message: {}", e);
                }
            }
            Some(Err(e)) => {
                eprintln!("[PDS] Stream error: {}", e);
                // Try to reconnect after a delay
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                return Box::pin(watch_firehose(state)).await;
            }
            None => {
                println!("[PDS] Stream ended, reconnecting...");
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                return Box::pin(watch_firehose(state)).await;
            }
        }
    }
    })
}

/// Handle a firehose message
async fn handle_firehose_message<'a>(
    state: &ServerState,
    msg: SubscribeReposMessage<'a>,
) -> miette::Result<()> {
    match msg {
        SubscribeReposMessage::Commit(commit_msg) => {
            // Check if this commit is from our DID
            if commit_msg.repo.as_str() != state.did.as_str() {
                return Ok(());
            }

            // Check if any operation affects our site
            let target_path = format!("place.wisp.fs/{}", state.rkey);
            let has_site_update = commit_msg.ops.iter().any(|op| op.path.as_ref() == target_path);

            if has_site_update {
                // Debug: log all operations for this commit
                println!("[Debug] Commit has {} ops for {}", commit_msg.ops.len(), state.rkey);
                for op in &commit_msg.ops {
                    if op.path.as_ref() == target_path {
                        println!("[Debug]   - {} {}", op.action.as_ref(), op.path.as_ref());
                    }
                }
            }

            if has_site_update {
                // Use the commit CID as the version tracker
                let commit_cid = commit_msg.commit.to_string();

                // Check if this is a new commit
                let should_update = {
                    let last_cid = state.last_cid.read().await;
                    Some(commit_cid.clone()) != *last_cid
                };

                if should_update {
                    // Check operation types
                    let has_create_or_update = commit_msg.ops.iter().any(|op| {
                        op.path.as_ref() == target_path &&
                        (op.action.as_ref() == "create" || op.action.as_ref() == "update")
                    });
                    let has_delete = commit_msg.ops.iter().any(|op| {
                        op.path.as_ref() == target_path && op.action.as_ref() == "delete"
                    });

                    // If there's a create/update, pull the site (even if there's also a delete in the same commit)
                    if has_create_or_update {
                        println!("\n[Update] Detected change to site {} (commit: {})", state.rkey, commit_cid);
                        println!("[Update] Pulling latest version...");

                        // Pull the updated site
                        match pull_site(
                            state.did.clone(),
                            state.rkey.clone(),
                            state.output_dir.clone(),
                        )
                        .await
                        {
                            Ok(_) => {
                                // Update last CID
                                let mut last_cid = state.last_cid.write().await;
                                *last_cid = Some(commit_cid);

                                // Reload redirect rules
                                let new_redirect_rules = load_redirect_rules(&state.output_dir);
                                let mut redirect_rules = state.redirect_rules.write().await;
                                *redirect_rules = new_redirect_rules;

                                println!("[Update] ✓ Site updated successfully!\n");
                            }
                            Err(e) => {
                                eprintln!("[Update] Failed to pull site: {}", e);
                            }
                        }
                    } else if has_delete {
                        // Only a delete, no create/update
                        println!("\n[Update] Site {} was deleted", state.rkey);

                        // Update last CID so we don't process this commit again
                        let mut last_cid = state.last_cid.write().await;
                        *last_cid = Some(commit_cid);
                    }
                }
            }
        }
        _ => {
            // Ignore identity and account messages
        }
    }

    Ok(())
}

