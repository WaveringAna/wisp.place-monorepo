//! Command-line surface. Mirrors the TypeScript wispctl 1.x exactly: same
//! commands, aliases, flags, defaults and positional arguments.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "wispctl",
    version,
    about = "CLI for wisp.place - deploy static sites to the AT Protocol",
    subcommand_negates_reqs = true
)]
pub struct Cli {
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
    #[arg(long, value_name = "password")]
    pub password: Option<String>,
    #[command(flatten)]
    pub db: DbArg,
    /// Service DID to proxy through
    #[arg(long, value_name = "did:...")]
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
    /// Site name (defaults to directory name)
    #[arg(short, long, value_name = "name")]
    pub site: Option<String>,
    /// Enable directory listing
    #[arg(long)]
    pub directory: bool,
    /// Enable SPA mode (serve index.html for all routes)
    #[arg(long)]
    pub spa: bool,
    /// Number of concurrent uploads (backs off to 2 on rate limit)
    #[arg(short, long, value_name = "n", default_value_t = 3)]
    pub concurrency: usize,
    /// Force gzip compression for all files regardless of type
    #[arg(long)]
    pub force_gzip: bool,
    /// App password for headless authentication
    #[arg(long, value_name = "password")]
    pub password: Option<String>,
    #[command(flatten)]
    pub db: DbArg,
    /// Skip confirmation prompts
    #[arg(short, long)]
    pub yes: bool,
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
    /// Delete a site from wisp metadata and unmap its domains
    Delete {
        handle: Option<String>,
        /// Site rkey
        #[arg(short, long, value_name = "rkey")]
        site: Option<String>,
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
    #[arg(long, value_name = "password")]
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
}
