//! Command-line surface. Mirrors the TypeScript wispctl 1.x exactly: same
//! commands, aliases, flags, defaults and positional arguments.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "wispctl",
    version,
    about = "CLI for wisp.place - deploy static sites to the AT Protocol",
    subcommand_negates_reqs = true,
    // commander keeps the last of a repeated option instead of rejecting it.
    args_override_self = true,
    // `--version` prints the bare version, as commander did.
    disable_version_flag = true
)]
pub struct Cli {
    /// Output the version number
    #[arg(short = 'V', long)]
    pub version: bool,

    /// Suppress progress output — useful for CI/agents (also set via WISPCTL_NO_PROGRESS=1)
    #[arg(short, long, global = true)]
    pub quiet: bool,

    #[command(subcommand)]
    pub command: Option<Command>,

    /// `wispctl [handle] ...` with no subcommand deploys.
    #[command(flatten)]
    pub deploy: DeployArgs,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Deploy a static site to wisp.place
    Deploy(DeployArgs),
    /// Download a site from wisp.place to a local directory
    Pull(PullArgs),
    /// Serve a site locally with live updates from firehose
    Serve(ServeArgs),
    /// List sites and domains from wisp XRPC routes
    List(ListArgs),
    /// Manage domains with wisp XRPC
    #[command(alias = "domains")]
    Domain(DomainArgs),
    /// Manage sites with wisp XRPC
    Site(SiteArgs),
    /// Manage private sites (never published to your PDS)
    Private(PrivateArgs),
    /// Authenticate and store credentials for use from any directory
    Login(LoginArgs),
    /// Unlink the current directory, or forget an account everywhere
    Logout(LogoutArgs),
    /// Manage stored accounts
    Accounts(AccountsArgs),
    /// Manage pull-request preview webhooks
    Preview(PreviewArgs),
}

#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct PreviewArgs {
    #[command(subcommand)]
    pub command: PreviewCommand,
}

#[derive(Subcommand, Debug)]
pub enum PreviewCommand {
    /// Enable pull-request previews for a tangled repository
    Enable {
        /// Account that deploys the previews
        handle: Option<String>,
        /// Repository name on tangled
        #[arg(long, value_name = "name")]
        repo: String,
        /// Wisp subdomain label preview URLs live under; required with more than one claim
        #[arg(long, value_name = "label")]
        claim: Option<String>,
        /// DID that owns the repository when working as a collaborator
        #[arg(long, value_name = "did")]
        owner: Option<String>,
        /// Preview bot the webhook wakes
        #[arg(
            long,
            env = "WISPCTL_PREVIEW_BOT_URL",
            value_name = "url",
            default_value = "https://preview-bot.wisp.place"
        )]
        bot_url: String,
        /// Hostname suffix of preview URLs, to print the URL pattern
        #[arg(long, env = "WISPCTL_PREVIEW_HOST", value_name = "host")]
        preview_host: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Deploy a pull request's preview from a tangled spindle workflow
    Deploy(PreviewDeployArgs),
    /// Disable pull-request previews for a tangled repository
    Disable {
        /// Account that deploys the previews
        handle: Option<String>,
        /// Repository name on tangled
        #[arg(long, value_name = "name")]
        repo: String,
        /// DID that owns the repository, for previews enabled as a collaborator
        #[arg(long, value_name = "did")]
        owner: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
}

/// Everything but `--path` comes from the spindle's environment and the repo's preview webhook,
/// so the same workflow works for every repo.
#[derive(Args, Debug, Clone)]
pub struct PreviewDeployArgs {
    /// Account that deploys; defaults to the repo owner
    pub handle: Option<String>,
    /// Directory to deploy
    #[arg(short, long, value_name = "path")]
    pub path: PathBuf,
    /// Repository name on tangled
    #[arg(long, env = "TANGLED_REPO_NAME", value_name = "name")]
    pub repo: String,
    /// DID that owns the repository
    #[arg(long, env = "TANGLED_REPO_DID", value_name = "did")]
    pub owner: String,
    /// Pull request head commit; defaults to TANGLED_PR_SOURCE_SHA, then TANGLED_COMMIT_SHA
    #[arg(long, value_name = "sha")]
    pub sha: Option<String>,
    /// Hostname suffix of preview URLs
    #[arg(
        long,
        env = "WISPCTL_PREVIEW_HOST",
        value_name = "host",
        default_value = "preview.wisp.place"
    )]
    pub preview_host: String,
    /// Enable SPA mode (serve index.html for all routes)
    #[arg(long)]
    pub spa: bool,
    /// Response header for every file, as "Name: value" (repeatable)
    #[arg(
        long = "header",
        value_name = "header",
        value_parser = crate::commands::deploy::parse_header,
        action = clap::ArgAction::Append
    )]
    pub headers: Vec<(String, String)>,
    /// App password; the spindle secret WISP_APP_PASSWORD
    #[arg(
        long,
        env = "WISP_APP_PASSWORD",
        hide_env_values = true,
        value_name = "password",
        allow_hyphen_values = true
    )]
    pub password: Option<String>,
    #[command(flatten)]
    pub db: DbArg,
    /// Service DID to proxy through
    #[arg(long, env = "WISPCTL_SERVICE", value_name = "did:...")]
    pub service: Option<String>,
}

#[derive(Args, Debug, Clone, Default)]
pub struct DbArg {
    /// Account database path
    #[arg(long = "db", value_name = "path")]
    pub db: Option<PathBuf>,
}

/// Options shared by every command that calls the wisp XRPC service.
#[derive(Args, Debug, Clone, Default)]
pub struct XrpcOptions {
    /// App password for headless authentication
    #[arg(long, value_name = "password", allow_hyphen_values = true)]
    pub password: Option<String>,
    #[command(flatten)]
    pub db: DbArg,
    /// Service DID to proxy through
    #[arg(long, env = "WISPCTL_SERVICE", value_name = "did:...")]
    pub service: Option<String>,
    /// Output raw JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, Default)]
pub struct DeployArgs {
    /// Handle or DID to deploy as
    pub handle: Option<String>,
    /// Directory to deploy
    #[arg(short, long, value_name = "path")]
    pub path: Option<PathBuf>,
    /// Site name (prompted for when omitted)
    #[arg(short, long, value_name = "name")]
    pub site: Option<String>,
    /// Commit SHA (7 or 40 lowercase hex characters); deploy as pr-<sha7>
    #[arg(
        long = "sha",
        value_name = "sha",
        conflicts_with = "site",
        value_parser = crate::commands::deploy::preview_site_from_sha
    )]
    pub preview_site: Option<String>,
    /// Enable directory listing
    #[arg(long)]
    pub directory: bool,
    /// Enable SPA mode (serve index.html for all routes)
    #[arg(long)]
    pub spa: bool,
    /// Response header for every file, as "Name: value" (repeatable)
    #[arg(
        long = "header",
        value_name = "header",
        value_parser = crate::commands::deploy::parse_header,
        action = clap::ArgAction::Append
    )]
    pub headers: Vec<(String, String)>,
    /// Number of concurrent uploads (backs off to 2 on rate limit)
    #[arg(short, long, value_name = "n", default_value_t = 3)]
    pub concurrency: usize,
    /// Force gzip compression for all files regardless of type
    #[arg(long)]
    pub force_gzip: bool,
    /// App password for headless authentication
    #[arg(long, value_name = "password", allow_hyphen_values = true)]
    pub password: Option<String>,
    #[command(flatten)]
    pub db: DbArg,
    /// Skip confirmation prompts
    #[arg(short, long)]
    pub yes: bool,
    /// Hostname suffix for pull-request preview URLs
    #[arg(long, env = "WISPCTL_PREVIEW_HOST", value_name = "host")]
    pub preview_host: Option<String>,
    /// Wisp subdomain claim for pull-request preview URLs
    #[arg(long, env = "WISPCTL_PREVIEW_CLAIM", value_name = "label")]
    pub preview_claim: Option<String>,
    /// Service DID to proxy through
    #[arg(long, env = "WISPCTL_SERVICE", value_name = "did:...")]
    pub service: Option<String>,
    /// Set by `preview deploy`: take the preview claim from this repo's preview webhook.
    #[arg(skip)]
    pub preview_hook: Option<crate::commands::preview::HookRef>,
}

#[derive(Args, Debug, Clone)]
pub struct PullArgs {
    pub handle: String,
    /// Site name to pull
    #[arg(short, long, value_name = "name")]
    pub site: String,
    /// Output directory
    #[arg(short, long, value_name = "path", default_value = ".")]
    pub path: PathBuf,
}

#[derive(Args, Debug, Clone)]
pub struct ServeArgs {
    pub handle: String,
    /// Site name to serve
    #[arg(short, long, value_name = "name")]
    pub site: String,
    /// Local directory to cache site
    #[arg(short, long, value_name = "path", default_value = ".wisp-serve")]
    pub path: PathBuf,
    /// Port to serve on
    #[arg(short = 'P', long, value_name = "port", default_value_t = 8080)]
    pub port: u16,
    /// Bind address (defaults to loopback; use 0.0.0.0 for public access)
    #[arg(long, value_name = "host", default_value = "127.0.0.1")]
    pub host: String,
    /// Enable SPA mode (serve file for all unmatched routes, defaults to index.html)
    #[arg(long, value_name = "file", num_args = 0..=1, default_missing_value = "index.html")]
    pub spa: Option<String>,
    /// Enable directory listing
    #[arg(long)]
    pub directory_listing: bool,
}

#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct ListArgs {
    #[command(subcommand)]
    pub command: Option<ListCommand>,
    #[command(flatten)]
    pub xrpc: XrpcOptions,
}

#[derive(Subcommand, Debug)]
pub enum ListCommand {
    /// List domains for an account
    Domains(HandleXrpc),
    /// List sites and their mapped domains for an account
    Sites(HandleXrpc),
}

#[derive(Args, Debug, Clone)]
pub struct HandleXrpc {
    pub handle: Option<String>,
    #[command(flatten)]
    pub xrpc: XrpcOptions,
}

#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct DomainArgs {
    #[command(subcommand)]
    pub command: Option<DomainCommand>,
    #[command(flatten)]
    pub xrpc: XrpcOptions,
}

#[derive(Subcommand, Debug)]
pub enum DomainCommand {
    /// Claim a custom domain
    Claim {
        handle: Option<String>,
        /// Custom domain
        #[arg(short, long, value_name = "domain")]
        domain: Option<String>,
        /// Optional site rkey to map
        #[arg(short, long, value_name = "rkey")]
        site: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Claim a wisp subdomain
    ClaimSubdomain {
        handle: Option<String>,
        /// Subdomain handle
        #[arg(short = 'n', long, value_name = "name")]
        subdomain: Option<String>,
        /// Optional site rkey to map
        #[arg(short, long, value_name = "rkey")]
        site: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Get domain verification/claim status
    Status {
        handle: Option<String>,
        /// Domain
        #[arg(short, long, value_name = "domain")]
        domain: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Map a claimed domain to a site rkey
    AddSite {
        handle: Option<String>,
        /// Domain
        #[arg(short, long, value_name = "domain")]
        domain: Option<String>,
        /// Site rkey
        #[arg(short, long, value_name = "rkey")]
        site: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Delete a claimed domain
    Delete {
        handle: Option<String>,
        /// Domain
        #[arg(short, long, value_name = "domain")]
        domain: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Run DNS verification for a claimed custom domain
    Verify {
        handle: Option<String>,
        /// Domain
        #[arg(short, long, value_name = "domain")]
        domain: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
}

#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct SiteArgs {
    #[command(subcommand)]
    pub command: Option<SiteCommand>,
    #[command(flatten)]
    pub xrpc: XrpcOptions,
}

#[derive(Subcommand, Debug)]
pub enum SiteCommand {
    /// Delete sites from wisp metadata and unmap their domains
    Delete {
        handle: Option<String>,
        /// Site rkey (repeatable)
        #[arg(short, long, value_name = "rkey")]
        site: Vec<String>,
        /// Also delete the site's records from your repo
        #[arg(long)]
        records: bool,
        /// Skip sites that no longer exist instead of failing
        #[arg(long)]
        ignore_missing: bool,
        /// Skip delete confirmation
        #[arg(short, long)]
        yes: bool,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Delete stale preview sites and their records (rkeys starting `pr-`)
    Prune {
        handle: Option<String>,
        /// Only sites whose rkey starts with this; must start with `pr-`
        #[arg(long, value_name = "prefix", default_value = "pr-")]
        prefix: String,
        /// Only sites last updated at least this many days ago (0 for all)
        #[arg(long, value_name = "days")]
        older_than: u32,
        /// List what would be deleted without deleting
        #[arg(long)]
        dry_run: bool,
        /// Skip delete confirmation
        #[arg(short, long)]
        yes: bool,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
}

#[derive(Args, Debug)]
pub struct PrivateArgs {
    #[command(subcommand)]
    pub command: PrivateCommand,
}

#[derive(Subcommand, Debug)]
pub enum PrivateCommand {
    /// Upload a directory as a private site
    Deploy {
        handle: Option<String>,
        /// Directory to upload
        #[arg(short, long, value_name = "dir", default_value = ".")]
        path: PathBuf,
        /// Display name for the private site
        #[arg(short, long, value_name = "name")]
        name: Option<String>,
        /// Minutes until the site expires. Omit for the server default, 0 to never expire
        #[arg(short, long, value_name = "minutes")]
        expiry: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// List your private sites
    List(HandleXrpc),
    /// Delete a private site and all of its share links
    Delete {
        site_id: String,
        handle: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Create a shareable link for a private site
    Share {
        site_id: String,
        handle: Option<String>,
        /// Label to identify this link
        #[arg(short, long, value_name = "label")]
        label: Option<String>,
        /// Minutes until the link expires. Omit for the server default, 0 for none
        #[arg(short, long, value_name = "minutes")]
        expiry: Option<String>,
        /// Restrict the link to one account. They sign in to open it; the link alone grants nothing
        #[arg(short, long, value_name = "did")]
        to: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// List share links for a private site
    Shares {
        site_id: String,
        handle: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
    /// Revoke a share link immediately
    Revoke {
        site_id: String,
        share_id: String,
        handle: Option<String>,
        #[command(flatten)]
        xrpc: XrpcOptions,
    },
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    pub handle: String,
    #[command(flatten)]
    pub db: DbArg,
    /// Log in with an app password instead of OAuth (or set WISPCTL_APP_PASSWORD)
    #[arg(long, value_name = "password", allow_hyphen_values = true)]
    pub password: Option<String>,
}

#[derive(Args, Debug)]
pub struct LogoutArgs {
    pub handle: Option<String>,
    #[command(flatten)]
    pub db: DbArg,
    /// Forget every stored account and credential
    #[arg(long)]
    pub all: bool,
}

#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct AccountsArgs {
    #[command(subcommand)]
    pub command: Option<AccountsCommand>,
    /// `wispctl accounts` with no subcommand lists.
    #[command(flatten)]
    pub list: AccountsListArgs,
}

#[derive(Args, Debug, Clone, Default)]
pub struct AccountsListArgs {
    #[command(flatten)]
    pub db: DbArg,
    /// Output raw JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum AccountsCommand {
    /// List stored accounts
    List(AccountsListArgs),
    /// Set the account used in directories with no linked account
    Use {
        handle: String,
        #[command(flatten)]
        db: DbArg,
    },
    /// Forget an account and remove its stored credentials
    Remove {
        handle: String,
        #[command(flatten)]
        db: DbArg,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_consistent() {
        Cli::command().debug_assert();
    }

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("wispctl").chain(args.iter().copied())).unwrap()
    }

    #[test]
    fn bare_invocation_deploys() {
        let cli = parse(&["alice.bsky.social", "--path", ".", "--site", "blog"]);
        assert!(cli.command.is_none());
        assert_eq!(cli.deploy.handle.as_deref(), Some("alice.bsky.social"));
        assert_eq!(cli.deploy.site.as_deref(), Some("blog"));
        assert_eq!(cli.deploy.concurrency, 3);
    }

    #[test]
    fn deploy_sha_accepts_short_and_full_commits() {
        for sha in ["abcdef0", "abcdef0123456789abcdef0123456789abcdef01"] {
            for prefix in [vec!["wispctl"], vec!["wispctl", "deploy"]] {
                let args = prefix
                    .into_iter()
                    .chain(["alice.test", "--path", ".", "--sha", sha]);
                let cli = Cli::try_parse_from(args).unwrap();
                let deploy = match cli.command {
                    Some(Command::Deploy(args)) => args,
                    None => cli.deploy,
                    _ => panic!("expected deploy"),
                };
                assert_eq!(deploy.preview_site.as_deref(), Some("pr-abcdef0"));
                assert!(deploy.site.is_none());
            }
        }
    }

    #[test]
    fn deploy_sha_rejects_invalid_commits() {
        for sha in [
            "",
            "abcdef",
            "abcdef01",
            "ABCDEF0",
            "abcdeg0",
            "abcdef0/",
            "éabcdef",
            "abcdef0123456789abcdef0123456789abcdef0",
            "abcdef0123456789abcdef0123456789abcdef012",
        ] {
            let error = Cli::try_parse_from(["wispctl", "deploy", "--sha", sha]).unwrap_err();
            assert_eq!(
                error.kind(),
                clap::error::ErrorKind::ValueValidation,
                "{sha}"
            );
        }
    }

    #[test]
    fn deploy_sha_conflicts_with_site() {
        for prefix in [vec!["wispctl"], vec!["wispctl", "deploy"]] {
            let args = prefix
                .into_iter()
                .chain(["--sha", "abcdef0", "--site", "blog"]);
            let error = Cli::try_parse_from(args).unwrap_err();
            assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
        }
    }

    #[test]
    fn quiet_is_global() {
        let cli = parse(&["--quiet", "login", "alice.test"]);
        assert!(cli.quiet && matches!(cli.command, Some(Command::Login(_))));
        let cli = parse(&["login", "alice.test", "-q"]);
        assert!(cli.quiet && matches!(cli.command, Some(Command::Login(_))));
        let cli = parse(&["-q", "alice.test", "--site", "blog"]);
        assert!(cli.quiet && cli.command.is_none());
    }

    #[test]
    fn serve_spa_flag_takes_optional_file() {
        let Some(Command::Serve(args)) = parse(&["serve", "a.test", "-s", "x", "--spa"]).command
        else {
            panic!("expected serve");
        };
        assert_eq!(args.spa.as_deref(), Some("index.html"));
        assert_eq!(args.port, 8080);
        let Some(Command::Serve(args)) =
            parse(&["serve", "a.test", "-s", "x", "--spa", "app.html"]).command
        else {
            panic!("expected serve");
        };
        assert_eq!(args.spa.as_deref(), Some("app.html"));
    }

    #[test]
    fn domains_alias_and_bare_group() {
        assert!(matches!(
            parse(&["domains"]).command,
            Some(Command::Domain(DomainArgs { command: None, .. }))
        ));
        assert!(matches!(
            parse(&["domain", "claim", "a.test", "-d", "example.com"]).command,
            Some(Command::Domain(DomainArgs {
                command: Some(DomainCommand::Claim { .. }),
                ..
            }))
        ));
    }

    #[test]
    fn accounts_defaults_to_list() {
        let Some(Command::Accounts(args)) = parse(&["accounts", "--json"]).command else {
            panic!("expected accounts");
        };
        assert!(args.command.is_none() && args.list.json);
    }

    #[test]
    fn service_can_come_from_environment_and_flag_wins() {
        unsafe { std::env::set_var("WISPCTL_SERVICE", "localhost:8000") };
        let cli = parse(&["list"]);
        let Some(Command::List(args)) = cli.command else {
            panic!("expected list")
        };
        assert_eq!(args.xrpc.service.as_deref(), Some("localhost:8000"));
        let cli = parse(&["list", "--service", "wisp.place"]);
        let Some(Command::List(args)) = cli.command else {
            panic!("expected list")
        };
        assert_eq!(args.xrpc.service.as_deref(), Some("wisp.place"));
        unsafe { std::env::remove_var("WISPCTL_SERVICE") };
    }
}
