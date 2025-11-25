use crate::pull::pull_site;
use crate::redirects::{load_redirect_rules, match_redirect_rule, RedirectRule};
use crate::place_wisp::settings::Settings;
use axum::{
    Router,
    extract::Request,
    response::{Response, IntoResponse, Redirect},
    http::{StatusCode, Uri, header},
    body::Body,
};
use jacquard::CowStr;
use jacquard::api::com_atproto::sync::subscribe_repos::{SubscribeRepos, SubscribeReposMessage};
use jacquard::api::com_atproto::repo::get_record::GetRecord;
use jacquard_common::types::string::Did;
use jacquard_common::xrpc::{SubscriptionClient, TungsteniteSubscriptionClient, XrpcExt};
use jacquard_common::IntoStatic;
use jacquard_common::types::value::from_data;
use miette::IntoDiagnostic;
use n0_future::StreamExt;
use std::collections::HashMap;
use std::path::{PathBuf, Path};
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
    settings: Arc<RwLock<Option<Settings<'static>>>>,
}

/// Fetch settings for a site from the PDS
async fn fetch_settings(
    pds_url: &url::Url,
    did: &Did<'_>,
    rkey: &str,
) -> miette::Result<Option<Settings<'static>>> {
    use jacquard_common::types::ident::AtIdentifier;
    use jacquard_common::types::string::{Rkey as RkeyType, RecordKey};

    let client = reqwest::Client::new();
    let rkey_parsed = RkeyType::new(rkey).into_diagnostic()?;

    let request = GetRecord::new()
        .repo(AtIdentifier::Did(did.clone()))
        .collection(CowStr::from("place.wisp.settings"))
        .rkey(RecordKey::from(rkey_parsed))
        .build();

    match client.xrpc(pds_url.clone()).send(&request).await {
        Ok(response) => {
            let output = response.into_output().into_diagnostic()?;

            // Parse the record value as Settings
            match from_data::<Settings>(&output.value) {
                Ok(settings) => {
                    Ok(Some(settings.into_static()))
                }
                Err(_) => {
                    // Settings record exists but couldn't parse - use defaults
                    Ok(None)
                }
            }
        }
        Err(_) => {
            // Settings record doesn't exist
            Ok(None)
        }
    }
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

    // Resolve PDS URL (needed for settings fetch)
    let pds_url = resolver.pds_for_did(&did).await.into_diagnostic()?;

    // Create output directory if it doesn't exist
    std::fs::create_dir_all(&output_dir).into_diagnostic()?;

    // Initial pull of the site
    println!("Performing initial pull...");
    let did_str = CowStr::from(did.as_str().to_string());
    pull_site(did_str.clone(), rkey.clone(), output_dir.clone()).await?;

    // Fetch settings
    let settings = fetch_settings(&pds_url, &did, rkey.as_ref()).await?;
    if let Some(ref s) = settings {
        println!("\nSettings loaded:");
        if let Some(true) = s.directory_listing {
            println!("  • Directory listing: enabled");
        }
        if let Some(ref spa_file) = s.spa_mode {
            println!("  • SPA mode: enabled ({})", spa_file);
        }
        if let Some(ref custom404) = s.custom404 {
            println!("  • Custom 404: {}", custom404);
        }
    } else {
        println!("No settings configured (using defaults)");
    }

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
        settings: Arc::new(RwLock::new(settings)),
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

/// Serve a file for SPA mode
async fn serve_file_for_spa(output_dir: &Path, spa_file: &str) -> Response {
    let file_path = output_dir.join(spa_file.trim_start_matches('/'));

    match tokio::fs::read(&file_path).await {
        Ok(contents) => {
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Body::from(contents))
                .unwrap()
        }
        Err(_) => {
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// Serve custom 404 page
async fn serve_custom_404(output_dir: &Path, custom404_file: &str) -> Response {
    let file_path = output_dir.join(custom404_file.trim_start_matches('/'));

    match tokio::fs::read(&file_path).await {
        Ok(contents) => {
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Body::from(contents))
                .unwrap()
        }
        Err(_) => {
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// Serve directory listing
async fn serve_directory_listing(dir_path: &Path, url_path: &str) -> Response {
    match tokio::fs::read_dir(dir_path).await {
        Ok(mut entries) => {
            let mut html = String::from("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Directory listing</title>");
            html.push_str("<style>body{font-family:sans-serif;margin:2em}a{display:block;padding:0.5em;text-decoration:none;color:#0066cc}a:hover{background:#f0f0f0}</style>");
            html.push_str("</head><body>");
            html.push_str(&format!("<h1>Index of {}</h1>", url_path));
            html.push_str("<hr>");

            // Add parent directory link if not at root
            if url_path != "/" {
                let parent = if url_path.ends_with('/') {
                    format!("{}../", url_path)
                } else {
                    format!("{}/", url_path.rsplitn(2, '/').nth(1).unwrap_or("/"))
                };
                html.push_str(&format!("<a href='{}'>../</a>", parent));
            }

            let mut items = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(name) = entry.file_name().into_string() {
                    let is_dir = entry.path().is_dir();
                    let display_name = if is_dir {
                        format!("{}/", name)
                    } else {
                        name.clone()
                    };

                    let link_path = if url_path.ends_with('/') {
                        format!("{}{}", url_path, name)
                    } else {
                        format!("{}/{}", url_path, name)
                    };

                    items.push((display_name, link_path, is_dir));
                }
            }

            // Sort: directories first, then alphabetically
            items.sort_by(|a, b| {
                match (a.2, b.2) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.0.cmp(&b.0),
                }
            });

            for (display_name, link_path, _) in items {
                html.push_str(&format!("<a href='{}'>{}</a>", link_path, display_name));
            }

            html.push_str("</body></html>");

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Body::from(html))
                .unwrap()
        }
        Err(_) => {
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// Handle a request with redirect and settings support
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

    // Get settings
    let settings = state.settings.read().await.clone();

    // Check for redirect rules first
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

        // No redirect match, try to serve the file
        let response_result = serve_dir.call(req).await;

        match response_result {
            Ok(response) if response.status().is_success() => {
                // File served successfully
                response.into_response()
            }
            Ok(response) if response.status() == StatusCode::NOT_FOUND => {
                // File not found, check settings for fallback behavior
                if let Some(ref settings) = settings {
                    // SPA mode takes precedence
                    if let Some(ref spa_file) = settings.spa_mode {
                        // Serve the SPA file for all non-file routes
                        return serve_file_for_spa(&state.output_dir, spa_file.as_ref()).await;
                    }

                    // Check if path is a directory and directory listing is enabled
                    if let Some(true) = settings.directory_listing {
                        let file_path = state.output_dir.join(path.trim_start_matches('/'));
                        if file_path.is_dir() {
                            return serve_directory_listing(&file_path, path).await;
                        }
                    }

                    // Check for custom 404
                    if let Some(ref custom404) = settings.custom404 {
                        return serve_custom_404(&state.output_dir, custom404.as_ref()).await;
                    }
                }

                // No special handling, return 404
                StatusCode::NOT_FOUND.into_response()
            }
            Ok(response) => response.into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
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

            // Check if any operation affects our site or settings
            let site_path = format!("place.wisp.fs/{}", state.rkey);
            let settings_path = format!("place.wisp.settings/{}", state.rkey);
            let has_site_update = commit_msg.ops.iter().any(|op| op.path.as_ref() == site_path);
            let has_settings_update = commit_msg.ops.iter().any(|op| op.path.as_ref() == settings_path);

            if has_site_update {
                // Debug: log all operations for this commit
                println!("[Debug] Commit has {} ops for {}", commit_msg.ops.len(), state.rkey);
                for op in &commit_msg.ops {
                    if op.path.as_ref() == site_path {
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
                        op.path.as_ref() == site_path &&
                        (op.action.as_ref() == "create" || op.action.as_ref() == "update")
                    });
                    let has_delete = commit_msg.ops.iter().any(|op| {
                        op.path.as_ref() == site_path && op.action.as_ref() == "delete"
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

            // Handle settings updates
            if has_settings_update {
                println!("\n[Settings] Detected change to settings");

                // Resolve PDS URL
                use jacquard_identity::PublicResolver;
                use jacquard::prelude::IdentityResolver;

                let resolver = PublicResolver::default();
                let did = Did::new(&state.did).into_diagnostic()?;
                let pds_url = resolver.pds_for_did(&did).await.into_diagnostic()?;

                // Fetch updated settings
                match fetch_settings(&pds_url, &did, state.rkey.as_ref()).await {
                    Ok(new_settings) => {
                        let mut settings = state.settings.write().await;
                        *settings = new_settings.clone();
                        drop(settings);

                        if let Some(ref s) = new_settings {
                            println!("[Settings] Updated:");
                            if let Some(true) = s.directory_listing {
                                println!("  • Directory listing: enabled");
                            }
                            if let Some(ref spa_file) = s.spa_mode {
                                println!("  • SPA mode: enabled ({})", spa_file);
                            }
                            if let Some(ref custom404) = s.custom404 {
                                println!("  • Custom 404: {}", custom404);
                            }
                        } else {
                            println!("[Settings] Cleared (using defaults)");
                        }
                    }
                    Err(e) => {
                        eprintln!("[Settings] Failed to fetch updated settings: {}", e);
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

