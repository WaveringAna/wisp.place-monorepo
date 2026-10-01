//! Only active uploads own file buffers; work is replenished on every completion.
use super::repo::{SiteRepo, http_status};
use anyhow::Result;
use base64::Engine;
use futures_util::{StreamExt, stream::FuturesUnordered};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use wispplace_core::{
    blob::{
        compute_cid, gzip, gzip_cid_variants, gzip_variants, is_text_mime, mime_for,
        should_compress,
    },
    ignore::FileInfo,
    tree::{ExistingBlob, UploadResult},
};

pub async fn process(
    repo: &impl SiteRepo,
    files: &[FileInfo],
    existing: &BTreeMap<String, ExistingBlob>,
    concurrency: usize,
    base64: bool,
    force_gzip: bool,
) -> Result<Vec<(String, UploadResult)>> {
    let progress =
        wispplace_ui::progress("Uploading", files.len() as u64, wispplace_ui::Direction::Up);
    let limit = AtomicUsize::new(concurrency.max(1));
    let mut pending = files.iter();
    let mut workers = FuturesUnordered::new();
    let mut results = Vec::new();
    let (mut uploaded, mut reused) = (0, 0);
    loop {
        while workers.len() < limit.load(Ordering::Relaxed) {
            let Some(file) = pending.next() else {
                break;
            };
            let item = progress.start_item(
                file.relative_path.clone(),
                wispplace_ui::format_bytes(file.size),
            );
            let limit = &limit;
            workers.push(async move {
                (
                    item,
                    prepare(repo, file, existing, limit, base64, force_gzip).await,
                )
            });
        }
        let Some((item, result)) = workers.next().await else {
            break;
        };
        progress.finish_item(item);
        let (path, upload, was_reused) = match result {
            Ok(result) => result,
            Err(error) => {
                progress.fail("Failed to process files");
                return Err(error);
            }
        };
        if was_reused {
            reused += 1;
        } else {
            uploaded += 1;
        }
        results.push((path, upload));
        progress.advance(1);
        progress.set_note(format!("{uploaded} uploaded · {reused} reused"));
    }
    progress.succeed(format!(
        "Processed {} files ({uploaded} uploaded, {reused} reused)",
        files.len()
    ));
    results.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(results)
}

async fn prepare(
    repo: &impl SiteRepo,
    file: &FileInfo,
    existing: &BTreeMap<String, ExistingBlob>,
    limit: &AtomicUsize,
    use_base64: bool,
    force_gzip: bool,
) -> Result<(String, UploadResult, bool)> {
    let content = tokio::fs::read(&file.path).await?;
    let mime = mime_for(&file.relative_path);
    let compressed = force_gzip || should_compress(&mime, &file.relative_path);
    let base64 = compressed && !force_gzip && use_base64 && is_text_mime(&mime);
    let bytes = if compressed {
        tokio::task::spawn_blocking(move || gzip(&content)).await??
    } else {
        content
    };
    let previous = existing.get(&file.relative_path).filter(|blob| {
        if !compressed {
            return blob.cid == compute_cid(&bytes);
        }
        if base64 {
            gzip_variants(&bytes).any(|variant| {
                compute_cid(
                    base64::engine::general_purpose::STANDARD
                        .encode(variant)
                        .as_bytes(),
                ) == blob.cid
            })
        } else {
            gzip_cid_variants(&bytes).any(|candidate| candidate == blob.cid)
        }
    });
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into_bytes()
    } else {
        bytes
    };
    let reused = previous.is_some();
    let blob = match previous {
        Some(previous) => previous.blob.clone(),
        None => upload_retry(repo, bytes.into(), limit).await?,
    };
    Ok((
        file.relative_path.clone(),
        UploadResult {
            blob,
            encoding: compressed.then(|| "gzip".into()),
            mime_type: mime,
            base64,
        },
        reused,
    ))
}

async fn upload_retry(
    repo: &impl SiteRepo,
    bytes: bytes::Bytes,
    limit: &AtomicUsize,
) -> Result<jacquard::types::blob::BlobRef> {
    for attempt in 0..3 {
        match repo.upload(bytes.clone()).await {
            Ok(blob) => return Ok(blob),
            Err(error) if attempt == 2 => return Err(error),
            Err(error) => {
                let rate_limited = http_status(&error) == Some(429);
                if rate_limited && limit.fetch_min(2, Ordering::Relaxed) > 2 {
                    wispplace_ui::warning("Rate limited — reducing concurrency to 2");
                }
                tokio::time::sleep(Duration::from_millis(
                    (1 << attempt) * if rate_limited { 2000 } else { 500 },
                ))
                .await;
            }
        }
    }
    unreachable!("three attempts return or fail")
}
