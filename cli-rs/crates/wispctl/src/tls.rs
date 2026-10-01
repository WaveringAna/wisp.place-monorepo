//! TLS setup. reqwest is built without a bundled crypto provider (so aws-lc
//! stays out of the binary), which means ring has to be installed as the
//! process default before the first HTTPS client is created.

use std::sync::Once;

/// Install ring as rustls' process-wide provider. Idempotent; call it before
/// building any HTTP client (main does, tests that make clients must too).
pub fn install_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        // Err only means a provider is already installed, which is fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Make the Bun-built CLI's trust store available on Linux, where every TLS
/// stack here (reqwest's platform verifier and the firehose websocket) reads
/// roots through `SSL_CERT_FILE`:
///
/// - CI images such as debian-slim, busybox and nixery often ship no CA
///   bundle; Bun carried Mozilla's roots, so fall back to the same set.
/// - Bun honoured `NODE_EXTRA_CA_CERTS` (corporate CAs in CI); add it on top.
///
/// Returns the written bundle, which must outlive every TLS connection. Must
/// run before any other thread exists: it sets an environment variable.
pub fn fallback_roots() -> Option<tempfile::TempPath> {
    #[cfg(target_os = "linux")]
    {
        use rustls::pki_types::{CertificateDer, pem::PemObject};

        if std::env::var_os("SSL_CERT_FILE").is_some() || std::env::var_os("SSL_CERT_DIR").is_some()
        {
            return None;
        }
        let extra: Vec<CertificateDer<'static>> = std::env::var_os("NODE_EXTRA_CA_CERTS")
            .and_then(|path| CertificateDer::pem_file_iter(path).ok())
            .map(|certs| certs.filter_map(Result::ok).collect())
            .unwrap_or_default();
        let mut roots = rustls_native_certs::load_native_certs().certs;
        if roots.is_empty() {
            roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS.to_vec();
        } else if extra.is_empty() {
            return None;
        }
        roots.extend(extra);
        let path = write_bundle(&roots).ok()?;
        // SAFETY: called from main before the runtime or any other thread starts.
        unsafe { std::env::set_var("SSL_CERT_FILE", &path) };
        Some(path)
    }
    #[cfg(not(target_os = "linux"))]
    None
}

#[cfg(target_os = "linux")]
fn write_bundle(
    certs: &[rustls::pki_types::CertificateDer<'_>],
) -> std::io::Result<tempfile::TempPath> {
    use base64::Engine;
    use std::io::Write;

    let mut file = tempfile::Builder::new()
        .prefix("wispctl-roots-")
        .suffix(".pem")
        .tempfile()?;
    for cert in certs {
        let encoded = base64::engine::general_purpose::STANDARD.encode(cert.as_ref());
        writeln!(file, "-----BEGIN CERTIFICATE-----")?;
        for line in encoded.as_bytes().chunks(64) {
            file.write_all(line)?;
            writeln!(file)?;
        }
        writeln!(file, "-----END CERTIFICATE-----")?;
    }
    file.flush()?;
    Ok(file.into_temp_path())
}
