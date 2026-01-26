use base64::Engine;
use bytes::Bytes;
use flate2::read::GzDecoder;
use jacquard_common::types::blob::BlobRef;
use miette::IntoDiagnostic;
use std::io::Read;
use url::Url;

/// Download a blob from the PDS
pub async fn download_blob(pds_url: &Url, blob_ref: &BlobRef<'_>, did: &str) -> miette::Result<Bytes> {
    // Extract CID from blob ref
    let cid = blob_ref.blob().r#ref.to_string();
    
    // Construct blob download URL
    // The correct endpoint is: /xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}
    let blob_url = pds_url
        .join(&format!("/xrpc/com.atproto.sync.getBlob?did={}&cid={}", did, cid))
        .into_diagnostic()?;
    
    let client = reqwest::Client::new();
    let response = client
        .get(blob_url)
        .send()
        .await
        .into_diagnostic()?;
    
    if !response.status().is_success() {
        return Err(miette::miette!(
            "Failed to download blob: {}",
            response.status()
        ));
    }
    
    let bytes = response.bytes().await.into_diagnostic()?;
    Ok(bytes)
}

/// Decompress and decode a blob (base64 + gzip)
pub fn decompress_blob(data: &[u8], is_base64: bool, is_gzipped: bool) -> miette::Result<Vec<u8>> {
    let mut current_data = data.to_vec();
    
    // First, decode base64 if needed
    if is_base64 {
        current_data = base64::prelude::BASE64_STANDARD
            .decode(&current_data)
            .into_diagnostic()?;
    }
    
    // Then, decompress gzip if needed
    if is_gzipped {
        let mut decoder = GzDecoder::new(&current_data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).into_diagnostic()?;
        current_data = decompressed;
    }
    
    Ok(current_data)
}

/// Download and decompress a blob
pub async fn download_and_decompress_blob(
    pds_url: &Url,
    blob_ref: &BlobRef<'_>,
    did: &str,
    is_base64: bool,
    is_gzipped: bool,
) -> miette::Result<Vec<u8>> {
    let data = download_blob(pds_url, blob_ref, did).await?;
    decompress_blob(&data, is_base64, is_gzipped)
}

