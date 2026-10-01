//! Pull a public site, serve its local cache, and refresh it from the PDS firehose.
use crate::{
    cli::ServeArgs,
    commands::pull::{fetch_record, pull_site},
    firehose,
    serve::{
        dashboard::{Dashboard, SyncStatus},
        http,
        routing::{Settings, State},
    },
};
use anyhow::{Context, Result};
use jacquard_lexicon::schema::LexiconSchema;
use std::{path::PathBuf, sync::Arc};
use tokio::{
    net::TcpListener,
    sync::{RwLock, mpsc},
};
use wispplace_ui::{Line, s};

async fn fetch_settings(pds: &str, did: &str, site: &str) -> Option<Settings> {
    let record = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        fetch_record(pds, did, "place.wisp.settings", site),
    )
    .await
    .ok()?
    .ok()?;
    decode_settings(record.get("value")?.clone())
}

fn decode_settings(value: serde_json::Value) -> Option<Settings> {
    if value.get("$type")?.as_str()? != "place.wisp.settings" {
        return None;
    }
    let record: wispplace_lexicons::place_wisp::settings::Settings<String> =
        serde_json::from_value(value).ok()?;
    record.validate().ok()?;
    for header in record.headers.iter().flatten() {
        header.validate().ok()?;
    }
    Some(Settings {
        directory_listing: record.directory_listing.unwrap_or(false),
        clean_urls: record.clean_urls.unwrap_or(false),
        spa_mode: record.spa_mode,
        custom_404: record.custom404,
        index_files: record.index_files,
    })
}

async fn reload_updates(
    args: ServeArgs,
    root: PathBuf,
    did: String,
    pds: String,
    state: Arc<RwLock<State>>,
    mut updates: mpsc::Receiver<firehose::Update>,
    dashboard: Arc<Dashboard>,
) {
    while let Some(mut update) = updates.recv().await {
        // Collapse bursts while keeping pulls serialized and avoiding stale settings writes.
        while let Ok(next) = updates.try_recv() {
            update.site |= next.site;
            update.settings |= next.settings;
        }
        if update.site {
            wispplace_ui::warning("Site updated, re-pulling...");
            dashboard.sync(SyncStatus::Pulling, None);
            match pull_site(&args.handle, &args.site, &root).await {
                Ok(pulled) => {
                    dashboard.sync(SyncStatus::Idle, Some(pulled.file_count));
                    let rules = http::load_redirects(&root);
                    state.write().await.redirects = rules;
                    wispplace_ui::success("Site reloaded");
                }
                Err(error) => {
                    dashboard.sync(SyncStatus::Error(format!("{error:#}")), None);
                    wispplace_ui::warning(format!("Failed to reload site: {error:#}"));
                }
            }
        }
        if update.settings {
            wispplace_ui::info("Settings updated...");
            dashboard.sync(SyncStatus::Settings, None);
            let settings = fetch_settings(&pds, &did, &args.site).await;
            state.write().await.settings = settings;
            dashboard.sync(SyncStatus::Idle, None);
            wispplace_ui::success("Settings reloaded");
        }
    }
}

pub async fn run(args: ServeArgs) -> Result<()> {
    wispplace_ui::blank();
    wispplace_ui::note(Line::from(vec![
        s::accent("Serving "),
        s::accent_bold(args.site.clone()),
        s::accent(format!(" from {}", args.handle)),
    ]));
    wispplace_ui::blank();
    let pulled = pull_site(&args.handle, &args.site, &args.path).await?;
    let root = args
        .path
        .canonicalize()
        .context("Could not resolve cache directory")?;
    let state = Arc::new(RwLock::new(State {
        settings: fetch_settings(&pulled.pds, &pulled.did, &args.site).await,
        redirects: http::load_redirects(&root),
        spa_override: args.spa.clone(),
        directory_listing_override: args.directory_listing.then_some(true),
    }));
    let listener = TcpListener::bind((args.host.as_str(), args.port))
        .await
        .context("Could not start HTTP server")?;
    let address = listener.local_addr()?;
    wispplace_ui::success(format!("Server running at http://{address}"));
    wispplace_ui::info("Watching for updates via firehose...");
    let dashboard = Arc::new(Dashboard::new(
        format!("http://{address}"),
        args.site.clone(),
        pulled.file_count,
    ));
    let (sender, receiver) = mpsc::channel(32);
    // All long-lived futures are scoped to the command: cancellation drops sockets and tasks.
    tokio::select! {
        result = http::run(listener, root.clone(), state.clone()) => result,
        _ = firehose::watch(pulled.pds.clone(), pulled.did.clone(), args.site.clone(), sender, dashboard.clone()) => Ok(()),
        _ = reload_updates(args.clone(), root, pulled.did, pulled.pds, state, receiver, dashboard.clone()) => Ok(()),
        _ = tokio::signal::ctrl_c() => {
            wispplace_ui::info("Shutting down...");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::decode_settings;
    use serde_json::json;

    #[test]
    fn settings_require_correct_type_and_lexicon_constraints() {
        assert!(decode_settings(json!({"$type":"place.wisp.fs"})).is_none());
        assert!(
            decode_settings(json!({"$type":"place.wisp.settings", "spaMode":"x".repeat(501)}))
                .is_none()
        );
        assert!(decode_settings(json!({"$type":"place.wisp.settings", "headers":[{"name":"x".repeat(101), "value":"bad"}]})).is_none());
        let settings = decode_settings(json!({"$type":"place.wisp.settings", "directoryListing":true, "cleanUrls":true, "spaMode":"app.html"})).unwrap();
        assert!(settings.directory_listing);
        assert!(settings.clean_urls);
        assert_eq!(settings.spa_mode.as_deref(), Some("app.html"));
        let defaults = decode_settings(json!({"$type":"place.wisp.settings"})).unwrap();
        assert!(!defaults.directory_listing);
        assert!(!defaults.clean_urls);
    }
}
