//! Native OS credentials. App passwords never fall back to plaintext SQLite.
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

pub const KEYCHAIN_SERVICE: &str = "wispctl";
const PROBE_ACCOUNT: &str = "__wispctl_probe__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainProbeResult {
    pub available: bool,
    pub detail: Option<String>,
    pub module_available: bool,
}

trait SecretEntry {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
    fn remove(&self) -> Result<(), String>;
}

impl SecretEntry for keyring::Entry {
    fn read(&self) -> Result<Option<String>, String> {
        match self.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn write(&self, value: &str) -> Result<(), String> {
        self.set_password(value).map_err(|e| e.to_string())
    }
    fn remove(&self) -> Result<(), String> {
        self.delete_credential().map_err(|e| e.to_string())
    }
}

struct Keychain<E> {
    entries: HashMap<String, E>,
    secrets: HashMap<String, Option<String>>,
    probe: Option<KeychainProbeResult>,
}

impl<E: SecretEntry> Keychain<E> {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            secrets: HashMap::new(),
            probe: None,
        }
    }

    fn entry(
        &mut self,
        account: &str,
        create: impl FnOnce(&str) -> Result<E, String>,
    ) -> Result<&E, String> {
        if !self.entries.contains_key(account) {
            self.entries.insert(account.to_owned(), create(account)?);
        }
        Ok(&self.entries[account])
    }

    fn read(
        &mut self,
        account: &str,
        create: impl FnOnce(&str) -> Result<E, String>,
    ) -> Option<String> {
        if let Some(value) = self.secrets.get(account) {
            return value.clone();
        }
        let value = self.entry(account, create).ok()?.read().ok().flatten();
        self.secrets.insert(account.to_owned(), value.clone());
        value
    }

    fn write(
        &mut self,
        account: &str,
        value: &str,
        create: impl FnOnce(&str) -> Result<E, String>,
    ) -> bool {
        if self
            .entry(account, create)
            .and_then(|entry| entry.write(value))
            .is_err()
        {
            return false;
        }
        self.secrets
            .insert(account.to_owned(), Some(value.to_owned()));
        true
    }

    fn remove(&mut self, account: &str, create: impl FnOnce(&str) -> Result<E, String>) {
        if let Ok(entry) = self.entry(account, create) {
            let _ = entry.remove();
        }
        self.secrets.insert(account.to_owned(), None);
    }

    fn probe(
        &mut self,
        module_available: bool,
        create: impl FnOnce(&str) -> Result<E, String>,
    ) -> KeychainProbeResult {
        if let Some(result) = &self.probe {
            return result.clone();
        }
        let result = if module_available {
            // A missing sentinel is success; never write a probe credential.
            match self
                .entry(PROBE_ACCOUNT, create)
                .and_then(SecretEntry::read)
            {
                Ok(_) => KeychainProbeResult {
                    available: true,
                    module_available,
                    detail: None,
                },
                Err(detail) => KeychainProbeResult {
                    available: false,
                    module_available,
                    detail: Some(detail),
                },
            }
        } else {
            KeychainProbeResult {
                available: false,
                module_available,
                detail: None,
            }
        };
        self.probe = Some(result.clone());
        result
    }
}

static KEYCHAIN: LazyLock<Mutex<Keychain<keyring::Entry>>> =
    LazyLock::new(|| Mutex::new(Keychain::new()));

fn create_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| {
        keyring::Entry::store_status()
            .as_ref()
            .err()
            .unwrap_or(&e)
            .to_string()
    })
}

fn with_keychain<T>(operation: impl FnOnce(&mut Keychain<keyring::Entry>) -> T) -> T {
    let mut cache = KEYCHAIN.lock().unwrap_or_else(|e| e.into_inner());
    operation(&mut cache)
}

fn keychain_disabled() -> bool {
    std::env::var_os("WISPCTL_NO_KEYCHAIN").is_some_and(|value| value == "1")
}

pub fn read_secret(account: &str) -> Option<String> {
    if keychain_disabled() {
        return None;
    }
    with_keychain(|cache| cache.read(account, create_entry))
}

pub fn write_secret(account: &str, value: &str) -> bool {
    if keychain_disabled() {
        return false;
    }
    with_keychain(|cache| cache.write(account, value, create_entry))
}

pub fn remove_secret(account: &str) {
    if keychain_disabled() {
        return;
    }
    with_keychain(|cache| cache.remove(account, create_entry));
}

pub fn probe_keychain() -> KeychainProbeResult {
    if keychain_disabled() {
        return KeychainProbeResult {
            available: false,
            module_available: false,
            detail: None,
        };
    }
    let supported = cfg!(all(
        any(unix, windows),
        not(any(target_os = "ios", target_os = "android"))
    ));
    with_keychain(|cache| cache.probe(supported, create_entry))
}

pub fn get_stored_app_password(did: &str) -> Option<String> {
    read_secret(&format!("app-password:{did}"))
}
pub fn set_stored_app_password(did: &str, password: &str) -> bool {
    write_secret(&format!("app-password:{did}"), password)
}
pub fn delete_stored_app_password(did: &str) {
    remove_secret(&format!("app-password:{did}"));
}

/// Legacy TS sessions are only removed, never restored as jacquard sessions.
pub fn delete_stored_oauth_session(did: &str) {
    remove_secret(did);
}

pub fn describe_unavailable_keychain(result: &KeychainProbeResult) -> String {
    describe_for_platform(result, std::env::consts::OS)
}

fn describe_for_platform(result: &KeychainProbeResult, platform: &str) -> String {
    let detail = result.detail.as_deref();
    let lower = detail.unwrap_or_default().to_lowercase();
    match platform {
        "macos" if !result.module_available => {
            "macOS Keychain support is unavailable in this build.".into()
        }
        "macos" if lower.contains("authorization") => {
            "macOS Keychain access could not be authorized.".into()
        }
        "macos" => detail.map_or_else(
            || "macOS Keychain access is unavailable.".into(),
            |d| format!("macOS Keychain access failed: {d}"),
        ),
        "linux" if !result.module_available => {
            "System keychain support is unavailable in this build.".into()
        }
        "linux" if lower.contains("secret service") => {
            "System keychain is unavailable (no Secret Service daemon or equivalent).".into()
        }
        "linux" => detail.map_or_else(
            || "System keychain is unavailable.".into(),
            |d| format!("System keychain access failed: {d}"),
        ),
        "windows" if !result.module_available => {
            "Windows Credential Manager support is unavailable in this build.".into()
        }
        "windows" => detail.map_or_else(
            || "Windows Credential Manager is unavailable.".into(),
            |d| format!("Windows Credential Manager access failed: {d}"),
        ),
        _ if !result.module_available => {
            "Secure OS credential storage is unavailable in this build.".into()
        }
        _ => detail.map_or_else(
            || "Secure OS credential storage is unavailable.".into(),
            |d| format!("Secure OS credential storage failed: {d}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    #[derive(Default)]
    struct Calls {
        reads: Cell<usize>,
        writes: Cell<usize>,
        removes: Cell<usize>,
        value: RefCell<Option<String>>,
        fail: Cell<bool>,
    }
    struct Fake(Rc<Calls>);
    impl SecretEntry for Fake {
        fn read(&self) -> Result<Option<String>, String> {
            self.0.reads.set(self.0.reads.get() + 1);
            if self.0.fail.get() {
                Err("Secret Service unavailable".into())
            } else {
                Ok(self.0.value.borrow().clone())
            }
        }
        fn write(&self, value: &str) -> Result<(), String> {
            self.0.writes.set(self.0.writes.get() + 1);
            if self.0.fail.get() {
                return Err("denied".into());
            }
            *self.0.value.borrow_mut() = Some(value.into());
            Ok(())
        }
        fn remove(&self) -> Result<(), String> {
            self.0.removes.set(self.0.removes.get() + 1);
            if self.0.fail.get() {
                return Err("denied".into());
            }
            *self.0.value.borrow_mut() = None;
            Ok(())
        }
    }

    #[test]
    fn probe_is_read_only_and_cached() {
        let calls = Rc::new(Calls::default());
        let mut cache = Keychain::new();
        assert!(cache.probe(true, |_| Ok(Fake(calls.clone()))).available);
        assert!(
            cache
                .probe(true, |_| panic!("cached probe should not create an entry"))
                .available
        );
        assert_eq!(calls.reads.get(), 1);
        assert_eq!(calls.writes.get(), 0);
        assert_eq!(calls.removes.get(), 0);
    }

    #[test]
    fn caches_entries_and_both_missing_and_present_secrets() {
        let calls = Rc::new(Calls::default());
        let mut cache = Keychain::new();
        assert_eq!(cache.read("did", |_| Ok(Fake(calls.clone()))), None);
        assert_eq!(cache.read("did", |_| panic!("already cached")), None);
        assert!(cache.write("did", "token", |_| panic!("reuse entry")));
        assert_eq!(
            cache.read("did", |_| panic!("already cached")),
            Some("token".into())
        );
        cache.remove("did", |_| panic!("reuse entry"));
        assert_eq!(cache.read("did", |_| panic!("already cached")), None);
        assert_eq!(calls.reads.get(), 1);
        assert_eq!(calls.writes.get(), 1);
        assert_eq!(calls.removes.get(), 1);
    }

    #[test]
    fn caches_errors_without_plaintext_fallback() {
        let calls = Rc::new(Calls::default());
        calls.fail.set(true);
        let mut cache = Keychain::new();
        assert!(!cache.probe(true, |_| Ok(Fake(calls.clone()))).available);
        assert!(!cache.write("app-password:did", "secret", |_| Ok(Fake(calls.clone()))));
        assert_eq!(
            cache.read("app-password:did", |_| panic!("reuse entry")),
            None
        );
        assert_eq!(
            cache.read("app-password:did", |_| panic!("cached read")),
            None
        );
        assert_eq!(calls.reads.get(), 2);
        assert!(cache.secrets.values().all(Option::is_none));
    }

    #[test]
    fn write_failure_preserves_cache_and_delete_failure_invalidates_it() {
        let calls = Rc::new(Calls::default());
        let mut cache = Keychain::new();
        assert!(cache.write("did", "original", |_| Ok(Fake(calls.clone()))));
        calls.fail.set(true);
        assert!(!cache.write("did", "replacement", |_| panic!("reuse entry")));
        assert_eq!(
            cache.read("did", |_| panic!("cached")),
            Some("original".into())
        );
        cache.remove("did", |_| panic!("reuse entry"));
        assert_eq!(cache.read("did", |_| panic!("cached")), None);
        assert_eq!(calls.value.borrow().as_deref(), Some("original"));
    }

    #[test]
    fn missing_backend_probe_and_initialization_failure_are_cached() {
        let mut cache: Keychain<Fake> = Keychain::new();
        assert!(
            !cache
                .probe(false, |_| panic!("unsupported backend"))
                .module_available
        );
        assert!(!cache.probe(true, |_| panic!("cached probe")).available);
        let mut cache: Keychain<Fake> = Keychain::new();
        let result = cache.probe(true, |_| Err("initialization failed".into()));
        assert!(result.module_available);
        assert!(!result.available);
        assert_eq!(result.detail.as_deref(), Some("initialization failed"));
        assert_eq!(cache.probe(true, |_| panic!("cached failure")), result);
    }

    #[test]
    fn platform_error_wording() {
        let unavailable = KeychainProbeResult {
            available: false,
            module_available: false,
            detail: None,
        };
        assert_eq!(
            describe_for_platform(&unavailable, "macos"),
            "macOS Keychain support is unavailable in this build."
        );
        let failed = KeychainProbeResult {
            available: false,
            module_available: true,
            detail: Some("Authorization refused".into()),
        };
        assert_eq!(
            describe_for_platform(&failed, "macos"),
            "macOS Keychain access could not be authorized."
        );
        let failed = KeychainProbeResult {
            detail: Some("No Secret Service".into()),
            ..failed
        };
        assert_eq!(
            describe_for_platform(&failed, "linux"),
            "System keychain is unavailable (no Secret Service daemon or equivalent)."
        );
    }
}
