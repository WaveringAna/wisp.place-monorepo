use crate::pull::pull_site;
use axum::Router;
use jacquard::CowStr;
use jacquard_common::jetstream::{CommitOperation, JetstreamMessage, JetstreamParams};
use jacquard_common::types::string::Did;
use jacquard_common::xrpc::{SubscriptionClient, TungsteniteSubscriptionClient};
use miette::IntoDiagnostic;
use n0_future::StreamExt;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;
use url::Url;

/// Shared state for the server
#[derive(Clone)]
struct ServerState {
    did: CowStr<'static>,
    rkey: CowStr<'static>,
    output_dir: PathBuf,
    last_cid: Arc<RwLock<Option<String>>>,
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

    // Create shared state
    let state = ServerState {
        did: did_str.clone(),
        rkey: rkey.clone(),
        output_dir: output_dir.clone(),
        last_cid: Arc::new(RwLock::new(None)),
    };

    // Start firehose listener in background
    let firehose_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = watch_firehose(firehose_state).await {
            eprintln!("Firehose error: {}", e);
        }
    });

    // Create HTTP server with gzip compression
    let app = Router::new()
        .fallback_service(
            ServeDir::new(&output_dir)
                .precompressed_gzip()
        )
        .layer(CompressionLayer::new())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .into_diagnostic()?;

    println!("\n✓ Server running at http://localhost:{}", port);
    println!("  Watching for updates on the firehose...\n");

    axum::serve(listener, app).await.into_diagnostic()?;

    Ok(())
}

/// Watch the firehose for updates to the specific site
fn watch_firehose(state: ServerState) -> std::pin::Pin<Box<dyn std::future::Future<Output = miette::Result<()>> + Send>> {
    Box::pin(async move {
    let jetstream_url = Url::parse("wss://jetstream1.us-east.fire.hose.cam")
        .into_diagnostic()?;

    println!("[Firehose] Connecting to Jetstream...");

    // Create subscription client
    let client = TungsteniteSubscriptionClient::from_base_uri(jetstream_url);

    // Subscribe with no filters (we'll filter manually)
    // Jetstream doesn't support filtering by collection in the params builder
    let params = JetstreamParams::new().build();

    let stream = client.subscribe(&params).await.into_diagnostic()?;
    println!("[Firehose] Connected! Watching for updates...");

    // Convert to typed message stream
    let (_sink, mut messages) = stream.into_stream();

    loop {
        match messages.next().await {
            Some(Ok(msg)) => {
                if let Err(e) = handle_firehose_message(&state, msg).await {
                    eprintln!("[Firehose] Error handling message: {}", e);
                }
            }
            Some(Err(e)) => {
                eprintln!("[Firehose] Stream error: {}", e);
                // Try to reconnect after a delay
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                return Box::pin(watch_firehose(state)).await;
            }
            None => {
                println!("[Firehose] Stream ended, reconnecting...");
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                return Box::pin(watch_firehose(state)).await;
            }
        }
    }
    })
}

/// Handle a firehose message
async fn handle_firehose_message(
    state: &ServerState,
    msg: JetstreamMessage<'_>,
) -> miette::Result<()> {
    match msg {
        JetstreamMessage::Commit {
            did,
            commit,
            ..
        } => {
            // Check if this is our site
            if did.as_str() == state.did.as_str()
                && commit.collection.as_str() == "place.wisp.fs"
                && commit.rkey.as_str() == state.rkey.as_str()
            {
                match commit.operation {
                    CommitOperation::Create | CommitOperation::Update => {
                        let new_cid = commit.cid.as_ref().map(|c| c.to_string());
                        
                        // Check if CID changed
                        let should_update = {
                            let last_cid = state.last_cid.read().await;
                            new_cid != *last_cid
                        };

                        if should_update {
                            println!("\n[Update] Detected change to site {} (CID: {:?})", state.rkey, new_cid);
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
                                    *last_cid = new_cid;
                                    println!("[Update] ✓ Site updated successfully!\n");
                                }
                                Err(e) => {
                                    eprintln!("[Update] Failed to pull site: {}", e);
                                }
                            }
                        }
                    }
                    CommitOperation::Delete => {
                        println!("\n[Update] Site {} was deleted", state.rkey);
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

