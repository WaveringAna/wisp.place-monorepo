//! Repository effects for deployment, typed by the generated place.wisp.* records.
use anyhow::Result;
use jacquard::{
    client::{Agent, AgentSession, AgentSessionExt, CollectionErr, CollectionOutput},
    identity::resolver::IdentityResolver,
    types::{
        blob::{BlobRef, MimeType},
        collection::Collection,
        recordkey::{RecordKey, Rkey},
        string::AtUri,
    },
};
use serde::{Serialize, de::DeserializeOwned};
use std::time::Duration;

/// What deploy needs from a repository. Records are addressed by collection
/// type; writes always go to the authenticated account's repo.
pub trait SiteRepo {
    /// `at://{did}/{R::NSID}/{rkey}`, decoded as `R`.
    async fn fetch<R>(&self, did: &str, rkey: &str) -> Result<R>
    where
        R: Collection + From<CollectionOutput<R>>,
        CollectionOutput<R>: DeserializeOwned,
        CollectionErr<R>: Send + Sync + 'static;
    async fn put<R: Collection + Serialize + Clone>(&self, rkey: &str, record: R) -> Result<()>;
    async fn delete<R: Collection + Serialize>(&self, rkey: &str) -> Result<()>;
    async fn upload(&self, bytes: bytes::Bytes) -> Result<BlobRef>;
}

fn record_key(rkey: &str) -> Result<RecordKey<Rkey>> {
    Ok(RecordKey(Rkey::new_owned(rkey)?))
}

impl<A: AgentSession + IdentityResolver> SiteRepo for Agent<A> {
    async fn fetch<R>(&self, did: &str, rkey: &str) -> Result<R>
    where
        R: Collection + From<CollectionOutput<R>>,
        CollectionOutput<R>: DeserializeOwned,
        CollectionErr<R>: Send + Sync + 'static,
    {
        let uri: AtUri = AtUri::new_owned(format!("at://{did}/{}/{rkey}", R::NSID))?;
        let output =
            retry_transport(|| async { Ok(self.get_record::<R, _>(&uri).await?.into_output()?) })
                .await?;
        Ok(R::from(output))
    }

    async fn put<R: Collection + Serialize + Clone>(&self, rkey: &str, record: R) -> Result<()> {
        let rkey = record_key(rkey)?;
        retry_transport(|| async {
            self.put_record::<R>(rkey.clone(), record.clone()).await?;
            Ok(())
        })
        .await
    }

    async fn delete<R: Collection + Serialize>(&self, rkey: &str) -> Result<()> {
        let rkey = record_key(rkey)?;
        retry_transport(|| async {
            self.delete_record::<R>(rkey.clone()).await?;
            Ok(())
        })
        .await
    }

    async fn upload(&self, bytes: bytes::Bytes) -> Result<BlobRef> {
        // Every blob is uploaded as opaque bytes; the manifest carries the real type.
        let blob = self
            .upload_blob(bytes, MimeType::new("application/octet-stream"))
            .await?;
        Ok(BlobRef::Blob(blob))
    }
}

/// Record calls address a fixed rkey, so repeating one is harmless: a
/// connection that drops mid-request (reset, TLS alert) is tried again up to
/// three times. HTTP errors are the server's answer and return at once, so a
/// manifest 500 still reaches deploy's base64 fallback.
async fn retry_transport<T, F>(call: impl Fn() -> F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    let mut attempt = 0;
    loop {
        match call().await {
            Err(error) if attempt < 2 && is_transport(&error) => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
            }
            result => return result,
        }
    }
}

/// Whether `error` failed below HTTP: no response arrived at all.
fn is_transport(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<jacquard::error::ClientError>()
            .is_some_and(|err| matches!(err.kind(), jacquard::error::ClientErrorKind::Transport))
    })
}

/// HTTP status of the first transport error in `error`'s chain.
pub fn http_status(error: &anyhow::Error) -> Option<u16> {
    error.chain().find_map(|cause| {
        cause
            .downcast_ref::<jacquard::error::ClientError>()
            .and_then(|err| err.status())
            .map(|s| s.as_u16())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jacquard::{client::AgentError, error::ClientError};
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Shaped like the prod failure: jacquard wraps the transport ClientError
    // in an AgentError, which `?` turns into anyhow.
    fn dropped_connection() -> anyhow::Error {
        let alert = std::io::Error::other("received fatal alert: BadRecordMac");
        AgentError::from(ClientError::transport(alert)).into()
    }

    fn server_error() -> anyhow::Error {
        let status = http::StatusCode::INTERNAL_SERVER_ERROR;
        AgentError::from(ClientError::http(status, Default::default(), None)).into()
    }

    #[test]
    fn transport_errors_are_told_apart_from_http_answers() {
        assert!(is_transport(&dropped_connection()));
        assert!(!is_transport(&server_error()));
        assert_eq!(http_status(&server_error()), Some(500));
    }

    #[tokio::test]
    async fn dropped_connections_are_retried() {
        let calls = AtomicUsize::new(0);
        let result = retry_transport(|| async {
            match calls.fetch_add(1, Ordering::Relaxed) {
                0 | 1 => Err(dropped_connection()),
                _ => Ok("written"),
            }
        })
        .await;
        assert_eq!(result.unwrap(), "written");
        assert_eq!(calls.into_inner(), 3);
    }

    #[tokio::test]
    async fn http_errors_return_on_the_first_attempt() {
        let calls = AtomicUsize::new(0);
        let result: Result<()> = retry_transport(|| async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err(server_error())
        })
        .await;
        assert_eq!(http_status(&result.unwrap_err()), Some(500));
        assert_eq!(calls.into_inner(), 1);
    }
}
