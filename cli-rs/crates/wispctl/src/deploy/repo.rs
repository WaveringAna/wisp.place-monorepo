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

/// What deploy needs from a repository. Records are addressed by collection
/// type; writes always go to the authenticated account's repo.
pub trait SiteRepo {
    /// `at://{did}/{R::NSID}/{rkey}`, decoded as `R`.
    async fn fetch<R>(&self, did: &str, rkey: &str) -> Result<R>
    where
        R: Collection + From<CollectionOutput<R>>,
        CollectionOutput<R>: DeserializeOwned,
        CollectionErr<R>: Send + Sync + 'static;
    async fn put<R: Collection + Serialize>(&self, rkey: &str, record: R) -> Result<()>;
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
        let output = self.get_record::<R, _>(&uri).await?.into_output()?;
        Ok(R::from(output))
    }

    async fn put<R: Collection + Serialize>(&self, rkey: &str, record: R) -> Result<()> {
        self.put_record::<R>(record_key(rkey)?, record).await?;
        Ok(())
    }

    async fn delete<R: Collection + Serialize>(&self, rkey: &str) -> Result<()> {
        self.delete_record::<R>(record_key(rkey)?).await?;
        Ok(())
    }

    async fn upload(&self, bytes: bytes::Bytes) -> Result<BlobRef> {
        // Every blob is uploaded as opaque bytes; the manifest carries the real type.
        let blob = self
            .upload_blob(bytes, MimeType::new("application/octet-stream"))
            .await?;
        Ok(BlobRef::Blob(blob))
    }
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
