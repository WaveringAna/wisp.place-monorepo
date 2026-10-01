use crate::{
    auth::WispAgent,
    cli::{PrivateArgs, PrivateCommand, XrpcOptions},
    xrpc::{self, items, text},
};
use anyhow::{Result, bail};
use jacquard::types::string::Datetime;
use serde_json::{Value, json};
use std::path::Path;
use wispplace_lexicons::place_wisp::v2::privateSite as private;
use wispplace_ui::{Line, Span, s};

use wispplace_core::constants::{
    MAX_PRIVATE_SITE_FILE_COUNT as MAX_FILES, MAX_PRIVATE_SITE_SIZE as MAX_SIZE,
};

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

fn expiry(raw: Option<&str>) -> Result<Option<i64>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let raw = raw.trim();
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| raw.strip_prefix(prefix).map(|digits| (digits, radix)));
    let value = if raw.is_empty() {
        0.0
    } else if let Some((digits, radix)) = radix {
        u64::from_str_radix(digits, radix)
            .map(|n| n as f64)
            .unwrap_or(f64::NAN)
    } else {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    };
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > i64::MAX as f64 {
        bail!("--expiry must be a non-negative whole number of minutes (0 disables expiry)");
    }
    Ok(Some(value as i64))
}

fn expiry_label(raw: Option<&str>) -> Span<'static> {
    let Some(raw) = raw else {
        return s::muted("never expires");
    };
    let Ok(when) = raw.parse::<Datetime>() else {
        return s::danger("expired");
    };
    let mins = ((when.timestamp_millis() - Datetime::now().timestamp_millis()) as f64 / 60000.0)
        .round() as i64;
    if mins <= 0 {
        s::danger("expired")
    } else if mins < 60 {
        s::warn(format!("expires in {mins}m"))
    } else if mins < 1440 {
        s::warn(format!(
            "expires in {}h",
            (mins as f64 / 60.0).round() as i64
        ))
    } else {
        s::muted(format!("expires {}", raw.get(..10).unwrap_or(raw)))
    }
}

fn size(data: &Value) -> String {
    format_bytes(data["totalBytes"].as_u64().unwrap_or(0))
}

pub async fn run(args: PrivateArgs) -> Result<()> {
    match args.command {
        PrivateCommand::Deploy {
            handle,
            path,
            name,
            expiry,
            xrpc,
        } => {
            let (agent, service, _) = xrpc::authenticate_for_xrpc(handle.as_deref(), &xrpc).await?;
            deploy(&agent, &service, &path, name.as_deref(), expiry.as_deref()).await
        }
        PrivateCommand::List(args) => {
            let (agent, service, _) =
                xrpc::authenticate_for_xrpc(args.handle.as_deref(), &args.xrpc).await?;
            let spinner = wispplace_ui::spinner("Fetching private sites...");
            let data = xrpc::send(&agent, &service, private::list::List, None).await?;
            spinner.succeed("Fetched private sites".to_owned());
            render_sites(&data);
            Ok(())
        }
        PrivateCommand::Delete {
            site_id,
            handle,
            xrpc,
        } => {
            let (agent, service, _) = xrpc::authenticate_for_xrpc(handle.as_deref(), &xrpc).await?;
            let spinner = wispplace_ui::spinner("Deleting private site...");
            xrpc::call::<private::delete::Delete>(&agent, &service, json!({"siteId": site_id}))
                .await?;
            spinner.succeed(format!("Deleted private site {site_id}"));
            Ok(())
        }
        PrivateCommand::Share {
            site_id,
            handle,
            label,
            expiry: raw_expiry,
            to,
            xrpc,
        } => {
            let (agent, service, _) = xrpc::authenticate_for_xrpc(handle.as_deref(), &xrpc).await?;
            let expiry_minutes = expiry(raw_expiry.as_deref())?;
            let spinner = wispplace_ui::spinner("Creating share link...");
            let data = xrpc::call::<private::create_share::CreateShare>(&agent, &service, json!({
                "siteId": site_id, "label": label, "expiryMinutes": expiry_minutes, "audienceDid": to,
            })).await?;
            spinner.succeed("Share link created".to_owned());
            render_share(&data, &site_id);
            Ok(())
        }
        PrivateCommand::Shares {
            site_id,
            handle,
            xrpc,
        } => shares(handle.as_deref(), &site_id, &xrpc).await,
        PrivateCommand::Revoke {
            site_id,
            share_id,
            handle,
            xrpc,
        } => {
            let (agent, service, _) = xrpc::authenticate_for_xrpc(handle.as_deref(), &xrpc).await?;
            let spinner = wispplace_ui::spinner("Revoking share link...");
            xrpc::call::<private::revoke_share::RevokeShare>(
                &agent,
                &service,
                json!({"siteId": site_id, "shareId": share_id}),
            )
            .await?;
            spinner.succeed(format!("Revoked share {share_id}"));
            Ok(())
        }
    }
}

fn normalize_directory(path: &Path) -> std::path::PathBuf {
    path.components()
        .fold(std::path::PathBuf::new(), |mut out, part| {
            match part {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                _ => out.push(part.as_os_str()),
            }
            out
        })
}

async fn deploy(
    agent: &WispAgent,
    service: &str,
    path: &Path,
    name: Option<&str>,
    raw_expiry: Option<&str>,
) -> Result<()> {
    let site_dir = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let site_dir = normalize_directory(&site_dir);
    if !site_dir.is_dir() {
        bail!("Not a directory: {}", site_dir.display());
    }
    let fallback = site_dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let name = name.filter(|s| !s.is_empty()).unwrap_or(fallback).trim();
    let expiry_minutes = expiry(raw_expiry)?;
    wispplace_ui::out(s::accent(format!(
        "\nCreating private site {name} from {}\n",
        site_dir.display()
    )));
    let spinner = wispplace_ui::spinner("Scanning directory...");
    let files = wispplace_core::ignore::collect_files(&site_dir)?;
    if files.is_empty() {
        spinner.fail("No files to upload".to_owned());
        bail!("No files found to upload");
    }
    if files.len() > MAX_FILES {
        spinner.fail("Too many files".to_owned());
        bail!(
            "Private sites are limited to {MAX_FILES} files (found {})",
            files.len()
        );
    }
    let total_bytes: u64 = files.iter().map(|file| file.size).sum();
    if total_bytes > MAX_SIZE {
        spinner.fail("Site too large".to_owned());
        bail!(
            "Private sites are limited to {} (found {})",
            format_bytes(MAX_SIZE),
            format_bytes(total_bytes)
        );
    }
    spinner.succeed(format!(
        "Found {} files ({})",
        files.len(),
        format_bytes(total_bytes)
    ));
    let spinner = wispplace_ui::spinner("Uploading privately...");
    let parts = files
        .iter()
        .map(|file| {
            Ok((
                file.relative_path.clone(),
                wispplace_core::blob::mime_for(&file.relative_path),
                std::fs::read(&file.path)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let (body, content_type) = multipart(name, expiry_minutes, &parts);
    let data = xrpc::send(
        agent,
        service,
        private::create::Create { body: body.into() },
        Some(&content_type),
    )
    .await?;
    spinner.succeed("Uploaded".to_owned());
    wispplace_ui::out("");
    wispplace_ui::out(Line::from(vec![
        s::bold("Private site: "),
        s::link(text(&data, "url").to_owned()),
    ]));
    wispplace_ui::out(format!("site id: {}", text(&data, "siteId")));
    wispplace_ui::out(format!(
        "files: {}  size: {}",
        data["fileCount"],
        size(&data)
    ));
    wispplace_ui::out(Line::from(vec![
        s::muted("expiry: "),
        expiry_label(data["expiresAt"].as_str()),
    ]));
    wispplace_ui::out("");
    wispplace_ui::out(s::muted("Only you can open that URL while signed in."));
    wispplace_ui::out(s::muted(format!(
        "Create a shareable link with: wisp private share {}",
        text(&data, "siteId")
    )));
    Ok(())
}

fn quote_filename(name: &str) -> String {
    name.replace('\r', "%0D")
        .replace('\n', "%0A")
        .replace('"', "%22")
}

fn multipart(
    name: &str,
    expiry: Option<i64>,
    files: &[(String, String, Vec<u8>)],
) -> (Vec<u8>, String) {
    // A deterministic candidate is fine, but never allow a file to terminate a part.
    let mut boundary = "----wispctl-private-upload".to_owned();
    while name.contains(&boundary)
        || files.iter().any(|(_, _, bytes)| {
            bytes
                .windows(boundary.len())
                .any(|w| w == boundary.as_bytes())
        })
    {
        boundary.push('x');
    }
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"name\"\r\n\r\n{name}\r\n"
        )
        .as_bytes(),
    );
    if let Some(expiry) = expiry {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"expiryMinutes\"\r\n\r\n{expiry}\r\n"
            )
            .as_bytes(),
        );
    }
    for (path, mime, bytes) in files {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"files\"; filename=\"{}\"\r\n\
             Content-Type: {mime}\r\n\r\n",
                quote_filename(path)
            )
            .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

fn render_sites(data: &Value) {
    let sites = items(data, "sites");
    if sites.is_empty() {
        wispplace_ui::out(s::muted("No private sites found."));
        return;
    }
    wispplace_ui::out(s::bold(format!("\nPrivate sites ({})", sites.len())));
    for site in sites {
        let name = text(site, "name");
        let header = if site["expired"] == true {
            s::danger(format!("{name} (expired)"))
        } else {
            s::bold(name.to_owned())
        };
        wispplace_ui::out(Line::from(vec![s::plain("- "), header]));
        wispplace_ui::out(format!("  id: {}", text(site, "siteId")));
        wispplace_ui::out(Line::from(vec![
            s::plain(format!(
                "  files: {}  size: {}  ",
                site["fileCount"],
                size(site)
            )),
            expiry_label(site["expiresAt"].as_str()),
        ]));
        wispplace_ui::out(format!("  active share links: {}", site["shareCount"]));
    }
}

fn render_share(data: &Value, site_id: &str) {
    wispplace_ui::out("");
    wispplace_ui::out(s::bold("Shareable link:"));
    wispplace_ui::out(s::link(text(data, "url").to_owned()));
    if let Some(direct) = data["directUrl"]
        .as_str()
        .filter(|direct| *direct != text(data, "url"))
    {
        wispplace_ui::out(s::muted(format!("direct: {direct}")));
    }
    wispplace_ui::out("");
    wispplace_ui::out(Line::from(vec![
        s::muted(format!("share id: {}  ", text(data, "shareId"))),
        expiry_label(data["expiresAt"].as_str()),
    ]));
    if let Some(audience) = data["audienceDid"].as_str() {
        wispplace_ui::out(s::muted(format!(
            "only {audience} can open this; they will be asked to sign in"
        )));
    }
    wispplace_ui::out(s::warn(
        "This link is shown once and cannot be retrieved later. Store it now.",
    ));
    wispplace_ui::out(s::muted(format!(
        "Revoke it with: wisp private revoke {site_id} {}",
        text(data, "shareId")
    )));
}

async fn shares(handle: Option<&str>, site_id: &str, opts: &XrpcOptions) -> Result<()> {
    let (agent, service, _) = xrpc::authenticate_for_xrpc(handle, opts).await?;
    let spinner = wispplace_ui::spinner("Fetching share links...");
    let data = xrpc::call::<private::list_shares::ListShares>(
        &agent,
        &service,
        json!({"siteId": site_id}),
    )
    .await?;
    spinner.succeed("Fetched share links".to_owned());
    let shares = items(&data, "shares");
    if shares.is_empty() {
        wispplace_ui::out(s::muted("No share links for this site."));
        return Ok(());
    }
    wispplace_ui::out(s::bold(format!("\nShare links ({})", shares.len())));
    for share in shares {
        let status = text(share, "status").to_owned();
        let color = match status.as_str() {
            "active" => s::ok(status),
            "revoked" => s::danger(status),
            _ => s::warn(status),
        };
        let label = share["label"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!(" ({s})"))
            .unwrap_or_default();
        wispplace_ui::out(Line::from(vec![
            s::plain(format!("- {}", text(share, "shareId"))),
            s::muted(label),
            s::plain(" "),
            color,
        ]));
        wispplace_ui::out(Line::from(vec![
            s::muted(format!("  token: {}...  ", text(share, "tokenPrefix"))),
            expiry_label(share["expiresAt"].as_str()),
        ]));
        if let Some(last) = share["lastUsedAt"].as_str() {
            wispplace_ui::out(format!("  last used: {last}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_names_are_lexical_not_symlink_targets() {
        assert_eq!(
            normalize_directory(Path::new("/var/./tmp/../site")),
            Path::new("/var/site")
        );
        assert_eq!(
            normalize_directory(Path::new("/../../site")),
            Path::new("/site")
        );
    }

    #[test]
    fn expiry_matches_number_conversion() {
        for raw in ["0", "", "  ", "1.0", "1e2", "0xff", "0o77", "0b11"] {
            assert!(expiry(Some(raw)).is_ok());
        }
        for raw in ["-1", "1.5", "NaN", "Infinity", "x", "+0xff", "0o8"] {
            assert!(expiry(Some(raw)).is_err());
        }
        assert_eq!(expiry(None).unwrap(), None);
    }
    #[test]
    fn multipart_is_binary_safe_and_escapes_headers() {
        let file = (
            "dir/\"\r\n.txt".into(),
            "text/plain".into(),
            b"----wispctl-private-upload\0".to_vec(),
        );
        let (body, content_type) = multipart("test", Some(0), &[file]);
        assert!(content_type.ends_with("uploadx"));
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains("filename=\"dir/%22%0D%0A.txt\""));
        assert!(body.contains("name=\"expiryMinutes\"\r\n\r\n0\r\n"));
        assert!(body.ends_with("----wispctl-private-uploadx--\r\n"));
    }
}
