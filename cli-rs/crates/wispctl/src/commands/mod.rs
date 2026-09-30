pub mod accounts;
pub mod deploy;
pub mod domain;
pub mod list;
pub mod login;
pub mod logout;
pub mod private;
pub mod pull;
pub mod serve;
pub mod site;

use anyhow::Result;

use crate::cli::{Cli, Command};

pub async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        None => deploy::run(cli.deploy).await,
        Some(Command::Deploy(args)) => deploy::run(args).await,
        Some(Command::Pull(args)) => pull::run(args).await,
        Some(Command::Serve(args)) => serve::run(args).await,
        Some(Command::List(args)) => list::run(args).await,
        Some(Command::Domain(args)) => domain::run(args).await,
        Some(Command::Site(args)) => site::run(args).await,
        Some(Command::Private(args)) => private::run(args).await,
        Some(Command::Login(args)) => login::run(args).await,
        Some(Command::Logout(args)) => logout::run(args).await,
        Some(Command::Accounts(args)) => accounts::run(args).await,
    }
}
