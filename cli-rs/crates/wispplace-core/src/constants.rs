//! Limits and defaults shared with the hosting service
//! (`packages/@wispplace/constants`). Keep in sync with the TypeScript source.

pub const MAX_SITE_SIZE: u64 = 300 * 1024 * 1024;
pub const MAX_SITE_SIZE_SUPPORTER: u64 = 700 * 1024 * 1024;
pub const MAX_FILE_SIZE: u64 = 200 * 1024 * 1024;
pub const MAX_FILE_COUNT: usize = 1000;
pub const MAX_BLOB_SIZE: u64 = MAX_FILE_SIZE;

pub const MAX_PRIVATE_SITE_SIZE: u64 = 100 * 1024 * 1024;
pub const MAX_PRIVATE_SITE_FILE_COUNT: usize = 500;

pub const GZIP_COMPRESSION_LEVEL: u32 = 9;

/// Hosting service DID used as the XRPC proxy target unless `--service` says otherwise.
pub const DEFAULT_WISP_SERVICE_DID: &str = "did:web:wisp.place";
/// Service id fragment in `atproto-proxy: <did>#wisp_xrpc`.
pub const WISP_PROXY_SERVICE_ID: &str = "wisp_xrpc";

pub const FS_COLLECTION: &str = "place.wisp.fs";
pub const SUBFS_COLLECTION: &str = "place.wisp.subfs";
pub const SETTINGS_COLLECTION: &str = "place.wisp.settings";

pub const DEFAULT_IGNORE_PATTERNS: &[&str] = &[
    ".git",
    ".git/**",
    ".github",
    ".github/**",
    ".gitlab",
    ".gitlab/**",
    ".DS_Store",
    ".wisp.metadata.json",
    ".wisp-metadata.json",
    ".env",
    ".env.*",
    "node_modules",
    "node_modules/**",
    "Thumbs.db",
    "desktop.ini",
    "._*",
    ".Spotlight-V100",
    ".Spotlight-V100/**",
    ".Trashes",
    ".Trashes/**",
    ".fseventsd",
    ".fseventsd/**",
    ".cache",
    ".cache/**",
    ".temp",
    ".temp/**",
    ".tmp",
    ".tmp/**",
    "__pycache__",
    "__pycache__/**",
    "*.pyc",
    ".venv",
    ".venv/**",
    "venv",
    "venv/**",
    "env",
    "env/**",
    "*.swp",
    "*.swo",
    ".tangled",
    ".tangled/**",
    ".wispignore",
];
