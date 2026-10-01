//! Prompt helpers with the CLI's cancellation behaviour: backing out of a
//! prompt prints the flow's cancel message and exits 0, like the old CLI.

use anyhow::{Result, bail};
use wispplace_ui::{Choice, PromptError, TextPrompt};

fn resolve<T>(result: Result<T, PromptError>, cancel_message: &str, flag_hint: &str) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(PromptError::Cancelled) => {
            wispplace_ui::cancelled(cancel_message);
            wispplace_ui::exit(0)
        }
        Err(PromptError::NotInteractive) => bail!("{flag_hint} (no terminal to prompt on)"),
    }
}

/// A required text value. `flag_hint` explains how to pass it without a
/// terminal, e.g. "Missing domain: pass --domain <domain>".
pub fn required_text(prompt: TextPrompt, cancel_message: &str, flag_hint: &str) -> Result<String> {
    resolve(wispplace_ui::text(prompt), cancel_message, flag_hint)
}

/// A value that must be non-empty; the usual `-d/--domain`-style prompt.
pub fn required_value(
    message: &str,
    placeholder: &str,
    empty_error: &'static str,
    cancel_message: &str,
    flag_hint: &str,
) -> Result<String> {
    let prompt = TextPrompt::new(message)
        .placeholder(placeholder)
        .validate(move |v| {
            if v.is_empty() {
                Err(empty_error.into())
            } else {
                Ok(())
            }
        });
    required_text(prompt, cancel_message, flag_hint)
}

pub fn select<T: Clone>(
    message: &str,
    choices: Vec<Choice<T>>,
    cancel_message: &str,
    flag_hint: &str,
) -> Result<T> {
    resolve(
        wispplace_ui::select(message, choices),
        cancel_message,
        flag_hint,
    )
}

pub fn confirm(message: &str, cancel_message: &str, flag_hint: &str) -> Result<bool> {
    resolve(wispplace_ui::confirm(message), cancel_message, flag_hint)
}

/// The handle prompt shared by every command that needs an account.
pub fn handle(cancel_message: &str) -> Result<String> {
    let prompt = TextPrompt::new("AT Protocol handle")
        .placeholder("alice.bsky.social")
        .validate(|v| {
            if v.is_empty() {
                Err("Handle is required".into())
            } else if !v.contains('.') {
                Err("Handle must include a domain (e.g., alice.bsky.social)".into())
            } else {
                Ok(())
            }
        });
    required_text(
        prompt,
        cancel_message,
        "Missing handle: pass it as an argument or run `wispctl login <handle>`",
    )
}
