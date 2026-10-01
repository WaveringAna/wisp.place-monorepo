mod auth;
mod cli;
mod commands;
mod deploy;
mod firehose;
mod prompts;
mod serve;
mod tls;
mod xrpc;

use std::future::pending;

use clap::Parser as _;

use crate::cli::{Cli, Command};

fn main() {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        // Help goes to stdout with 0; usage errors exit 1 like commander, not clap's 2.
        Err(err) if err.use_stderr() => {
            let _ = err.print();
            std::process::exit(1);
        }
        Err(err) => err.exit(),
    };
    let roots = tls::fallback_roots();
    tls::install_crypto_provider();
    let guard = wisp_ui::init(wisp_ui::Options { quiet: cli.quiet });
    if cli.version {
        wisp_ui::out_text(env!("CARGO_PKG_VERSION"));
        drop(guard);
        std::process::exit(0);
    }

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => {
            wisp_ui::error(format!("could not start the async runtime: {err}"));
            wisp_ui::exit(1);
        }
    };

    // `serve` shuts down on Ctrl-C itself and exits 0 like the old CLI.
    let handles_interrupt = matches!(cli.command, Some(Command::Serve(_)));
    let interrupted = async move {
        if handles_interrupt {
            pending::<()>().await;
        }
        let _ = tokio::signal::ctrl_c().await;
    };

    let code = runtime.block_on(async {
        tokio::select! {
            result = commands::run(cli) => match result {
                Ok(()) => 0,
                Err(err) => {
                    wisp_ui::error(format!("{err:#}"));
                    1
                }
            },
            () = interrupted => {
                wisp_ui::blank();
                wisp_ui::cancelled("Interrupted");
                130
            }
        }
    });

    drop(guard);
    // Long-lived tasks (serve's server and firehose) must not keep us alive.
    runtime.shutdown_background();
    drop(roots);
    std::process::exit(code);
}
