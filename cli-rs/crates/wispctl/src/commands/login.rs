//! Explicit OAuth or app-password login.
use crate::{
    auth::{self, AuthOptions, keychain},
    cli::LoginArgs,
    xrpc,
};
use anyhow::Result;
use wisp_ui::{Line, s};

pub async fn run(args: LoginArgs) -> Result<()> {
    let password = args
        .password
        .or_else(|| std::env::var("WISPCTL_APP_PASSWORD").ok());
    let password = password.map(|password| password.trim().to_owned());
    if password.as_ref().is_some_and(String::is_empty) {
        anyhow::bail!("App password is required");
    }
    let mut spinner = wisp_ui::spinner("Authenticating...");
    let result = auth::authenticate(
        Some(&args.handle),
        &AuthOptions {
            app_password: password.clone(),
            db_path: args.db.db,
            force_reauth: true,
        },
        |message| xrpc::bind_auth_status(&mut spinner, message),
    )
    .await?;
    let label = if password.is_some() {
        result.handle.as_deref().unwrap_or(&args.handle)
    } else {
        &result.did
    };
    spinner.succeed(format!("Authenticated as {label}"));
    if let Some(password) = password {
        if keychain::set_stored_app_password(&result.did, &password) {
            wisp_ui::out(Line::from(s::muted(
                "  App password saved to the system keychain",
            )));
        } else {
            wisp_ui::out(Line::from(s::warn(format!(
                "  App password not saved: {}",
                keychain::describe_unavailable_keychain(&keychain::probe_keychain())
            ))));
            wisp_ui::out(Line::from(s::muted(
                "  Use --password or WISPCTL_APP_PASSWORD for future commands.",
            )));
        }
    }
    Ok(())
}
