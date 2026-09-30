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
