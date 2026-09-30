//! Public PDS subscribeRepos websocket using jacquard's transport and DAG-CBOR decoder.
use crate::serve::dashboard::{Dashboard, FirehoseStatus};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use jacquard_api::com_atproto::sync::subscribe_repos::SubscribeReposMessage;
use jacquard_common::{
    deps::fluent_uri::Uri,
    websocket::{WebSocketClient, WsMessage, tungstenite_client::TungsteniteClient},
};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Update {
    pub site: bool,
    pub settings: bool,
}

fn matching_update(message: &SubscribeReposMessage<String>, did: &str, site: &str) -> Update {
    match message {
        SubscribeReposMessage::Commit(commit) if commit.repo.as_str() == did => {
            if commit.too_big {
                return Update {
                    site: true,
                    settings: true,
                };
            }
            commit
                .ops
                .iter()
                .filter(|op| matches!(op.action.as_str(), "create" | "update" | "delete"))
                .fold(Update::default(), |mut update, op| {
                    if let Some((collection, key)) = op.path.split_once('/')
                        && key == site
                    {
                        update.site |= collection == "place.wisp.fs";
                        update.settings |= collection == "place.wisp.settings";
                    }
                    update
                })
        }
        SubscribeReposMessage::Sync(sync) if sync.did.as_str() == did => Update {
            site: true,
            settings: true,
        },
        _ => Update::default(),
    }
}

fn websocket_url(pds: &str, cursor: Option<i64>) -> Result<String> {
    let base = pds.trim_end_matches('/');
    let url = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        bail!("Invalid PDS endpoint");
    };
    Ok(format!(
        "{url}/xrpc/com.atproto.sync.subscribeRepos{}",
        cursor
            .map(|seq| format!("?cursor={seq}"))
            .unwrap_or_default()
    ))
}

async fn subscribe(
    pds: &str,
    did: &str,
    site: &str,
    cursor: &mut Option<i64>,
    sender: &mpsc::Sender<Update>,
    dashboard: &Dashboard,
) -> Result<()> {
    let url = websocket_url(pds, *cursor)?;
    let uri = Uri::parse(url.as_str()).context("Invalid firehose URL")?;
    let connection = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TungsteniteClient::new().connect(uri),
    )
    .await??;
    dashboard.firehose(FirehoseStatus::Connected);
    let (_sink, receiver) = connection.split();
    let mut stream = receiver.into_inner();
    while let Some(message) = stream.next().await {
        let message = message?;
        let WsMessage::Binary(bytes) = message else {
            if message.is_close() {
                break;
            }
            continue;
        };
        let decoded = SubscribeReposMessage::<String>::decode_framed(&bytes)?;
        let update = matching_update(&decoded, did, site);
        if update.site || update.settings {
            sender
                .send(update)
                .await
                .context("Update receiver closed")?;
        }
        // Only resume after accepted messages; dropped frames are replayed on reconnect.
        let seq = match decoded {
            SubscribeReposMessage::Commit(c) => Some(c.seq),
            SubscribeReposMessage::Sync(s) => Some(s.seq),
            SubscribeReposMessage::Identity(i) => Some(i.seq),
            SubscribeReposMessage::Account(a) => Some(a.seq),
            SubscribeReposMessage::Info(info) => {
                if info.name.as_str() == "OutdatedCursor" {
                    *cursor = None;
                }
                None
            }
            _ => None,
        };
        if let Some(seq) = seq {
            *cursor = Some(seq);
        }
    }
    bail!("Firehose connection closed")
}

pub async fn watch(
    pds: String,
    did: String,
    site: String,
    sender: mpsc::Sender<Update>,
    dashboard: Arc<Dashboard>,
) {
    let mut cursor = None;
    loop {
        if sender.is_closed() {
            return;
        }
        if let Err(error) = subscribe(&pds, &did, &site, &mut cursor, &sender, &dashboard).await {
            dashboard.firehose(FirehoseStatus::Error(format!("{error:#}")));
            wisp_ui::warning(format!("Firehose error: {error:#}"));
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn websocket_endpoint_and_cursor() {
        assert_eq!(
            websocket_url("https://pds.example/", Some(42)).unwrap(),
            "wss://pds.example/xrpc/com.atproto.sync.subscribeRepos?cursor=42"
        );
        assert_eq!(
            websocket_url("http://localhost:3300", None).unwrap(),
            "ws://localhost:3300/xrpc/com.atproto.sync.subscribeRepos"
        );
        assert!(websocket_url("file:///etc", None).is_err());
    }
    fn commit(did: &str, ops: serde_json::Value, too_big: bool) -> SubscribeReposMessage<String> {
        let commit: jacquard_api::com_atproto::sync::subscribe_repos::Commit<String> =
            serde_json::from_str(&serde_json::json!({
                "repo": did, "seq": 42,
                "rev": "3jqfcqzm3fo2j", "time": "2026-01-01T00:00:00.000Z",
                "commit": {"$link": "bafkreigh2akiscaildcg6ez6jptywevd2cjfqxptzvtn2spgvknm7qrkta"},
                "blocks": [], "blobs": [], "ops": ops, "rebase": false, "tooBig": too_big,
            }).to_string())
            .unwrap();
        SubscribeReposMessage::Commit(Box::new(commit))
    }

    #[test]
    fn filters_did_collection_rkey_and_actions() {
        for action in ["create", "update", "delete"] {
            let message = commit(
                "did:plc:test",
                serde_json::json!([
                    {"action": action, "path": "place.wisp.fs/site"},
                    {"action": action, "path": "place.wisp.settings/site"},
                ]),
                false,
            );
            assert_eq!(
                matching_update(&message, "did:plc:test", "site"),
                Update {
                    site: true,
                    settings: true
                }
            );
            assert_eq!(
                matching_update(&message, "did:plc:other", "site"),
                Update::default()
            );
            assert_eq!(
                matching_update(&message, "did:plc:test", "other"),
                Update::default()
            );
        }
        let message = commit(
            "did:plc:test",
            serde_json::json!([
                {"action": "create", "path": "app.bsky.feed.post/site"},
                {"action": "future", "path": "place.wisp.fs/site"},
                {"action": "update", "path": "place.wisp.fs/site/extra"},
            ]),
            false,
        );
        assert_eq!(
            matching_update(&message, "did:plc:test", "site"),
            Update::default()
        );
        assert_eq!(
            matching_update(
                &commit("did:plc:test", serde_json::json!([]), true),
                "did:plc:test",
                "site"
            ),
            Update {
                site: true,
                settings: true
            }
        );
    }
}
