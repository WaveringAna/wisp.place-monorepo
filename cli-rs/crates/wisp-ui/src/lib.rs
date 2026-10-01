//! Terminal output for wispctl.
//!
//! Everything the CLI shows goes through this crate so the live region (spinners,
//! progress, prompts, panels) and ordinary printed lines never fight over the
//! terminal. Call [`init`] once at startup, keep the returned [`Guard`] alive for
//! the whole run, and never write to stdout/stderr directly while it is.
//!
//! Two modes, picked once by [`init`]:
//! - **Rich**: stderr is a terminal. Live elements render inline below the
//!   scrollback with ratatui, and finished work collapses into a single line.
//! - **Plain**: CI, pipes, `--quiet`, `WISPCTL_NO_PROGRESS=1`. No animation;
//!   finished work prints one `✓`/`✗` line, in-flight updates are dropped.
//!
//! Status goes to stderr. Only command *results* (`--json`, listings) go to
//! stdout via [`out`], so `wispctl list sites --json | jq` stays clean.

mod ansi;
mod live;
mod prompt;
mod runtime;
mod theme;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

pub use ratatui::text::{Line, Span};
pub use theme::{ColorSupport, Palette, palette, s};

pub use live::{Direction, PanelStatus};
pub use prompt::{Choice, PromptError, TextPrompt};

use live::Node;
use runtime::Runtime;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Rich,
    Plain,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    /// `--quiet`: never animate, even on a terminal.
    pub quiet: bool,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn rt() -> &'static Runtime {
    RUNTIME.get_or_init(|| Runtime::start(Options::default()))
}

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// Pick the output mode and start the renderer. Hold the guard until exit;
/// dropping it tears down the live region and restores the terminal.
pub fn init(options: Options) -> Guard {
    let _ = RUNTIME.set(Runtime::start(options));
    Guard(())
}

#[must_use = "dropping the guard tears the terminal UI down"]
pub struct Guard(());

impl Drop for Guard {
    fn drop(&mut self) {
        shutdown();
    }
}

/// Clear the live region and restore the terminal. Safe to call repeatedly,
/// and from a signal handler path before `std::process::exit`.
pub fn shutdown() {
    if let Some(rt) = RUNTIME.get() {
        rt.shutdown();
    }
}

/// Tear down the UI, then exit. Use instead of `std::process::exit`, which
/// skips destructors and would leave the cursor hidden.
pub fn exit(code: i32) -> ! {
    shutdown();
    std::process::exit(code)
}

pub fn mode() -> Mode {
    rt().mode()
}

/// Whether interactive prompts can be shown (stdin and stderr are terminals).
pub fn can_prompt() -> bool {
    rt().can_prompt()
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/// A command result on stdout (listings, `--json`, URLs a script may capture).
pub fn out(line: impl Into<Line<'static>>) {
    rt().print(runtime::Target::Stdout, vec![line.into()]);
}

/// Raw text on stdout, e.g. pretty JSON. Printed without styling.
pub fn out_text(text: &str) {
    let lines = text.lines().map(|l| Line::raw(l.to_owned())).collect();
    rt().print(runtime::Target::Stdout, lines);
}

/// A status line on stderr.
pub fn note(line: impl Into<Line<'static>>) {
    rt().print(runtime::Target::Stderr, vec![line.into()]);
}

/// An empty status line, for breathing room between sections.
pub fn blank() {
    note(Line::default());
}

/// Session header: `✦ wisp.place  deploy`.
pub fn intro(command: &str) {
    blank();
    note(Line::from(vec![
        s::accent("✦ "),
        s::bold("wisp.place"),
        s::plain("  "),
        s::muted(command.to_owned()),
    ]));
    blank();
}

/// Closing line after an interactive flow finished well.
pub fn outro(message: &str) {
    blank();
    note(Line::from(vec![s::accent("✦ "), s::ok(message.to_owned())]));
    blank();
}

/// The user backed out of a prompt. Printed in place of the flow's result.
pub fn cancelled(message: &str) {
    note(Line::from(vec![
        s::muted("■ "),
        s::muted(message.to_owned()),
    ]));
}

pub fn success(message: impl Into<String>) {
    note(glyph_line(s::ok("✓"), message.into()));
}

pub fn failure(message: impl Into<String>) {
    note(glyph_line(s::danger("✗"), message.into()));
}

pub fn warning(message: impl Into<String>) {
    note(Line::from(vec![s::warn("▲ "), s::warn(message.into())]));
}

pub fn info(message: impl Into<String>) {
    note(Line::from(vec![s::muted("· "), s::muted(message.into())]));
}

/// A fatal error, printed as the last thing before a non-zero exit. Plain
/// output keeps the TS CLI's `Error: ...` line start for log greps.
pub fn error(message: impl Into<String>) {
    blank();
    let glyph = (rt().mode() == Mode::Rich).then(|| s::danger("✗ "));
    note(Line::from_iter(
        glyph
            .into_iter()
            .chain([s::danger("Error: "), s::plain(message.into())]),
    ));
    blank();
}

fn glyph_line(glyph: Span<'static>, message: String) -> Line<'static> {
    Line::from(vec![glyph, s::plain(" "), s::plain(message)])
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/// Ask for a line of text. Blocks the calling thread until answered.
pub fn text(prompt: TextPrompt) -> Result<String, PromptError> {
    rt().prompt(prompt::Prompt::Text(prompt.into_state()))
        .map(prompt::Answer::into_text)
}

/// Pick one of `choices`. Blocks the calling thread until answered.
pub fn select<T: Clone>(message: &str, choices: Vec<Choice<T>>) -> Result<T, PromptError> {
    let labels = choices.iter().map(Choice::display).collect();
    let index = rt()
        .prompt(prompt::Prompt::Select(prompt::SelectState::new(
            message, labels,
        )))?
        .into_index();
    Ok(choices[index].value.clone())
}

/// Yes or no. Blocks the calling thread until answered.
pub fn confirm(message: &str) -> Result<bool, PromptError> {
    rt().prompt(prompt::Prompt::Confirm(prompt::ConfirmState::new(
        message, true,
    )))
    .map(prompt::Answer::into_bool)
}

// ---------------------------------------------------------------------------
// Live elements
// ---------------------------------------------------------------------------

/// A single line of in-flight work: `⠹ Authenticating...`.
///
/// Finish it with [`Spinner::succeed`] or [`Spinner::fail`]; dropping it
/// unfinished removes it without a trace.
pub struct Spinner {
    id: u64,
    text: String,
    done: bool,
}

pub fn spinner(text: impl Into<String>) -> Spinner {
    let text = text.into();
    let id = next_id();
    rt().upsert(id, Node::spinner(&text));
    Spinner {
        id,
        text,
        done: false,
    }
}

impl Spinner {
    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        rt().upsert(self.id, Node::spinner(&self.text));
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn succeed(mut self, message: impl Into<Option<String>>) {
        let message = message.into().unwrap_or_else(|| self.text.clone());
        self.finish(vec![glyph_line(s::ok("✓"), message)]);
    }

    pub fn fail(mut self, message: impl Into<Option<String>>) {
        let message = message.into().unwrap_or_else(|| self.text.clone());
        self.finish(vec![glyph_line(s::danger("✗"), message)]);
    }

    pub fn warn(mut self, message: impl Into<Option<String>>) {
        let message = message.into().unwrap_or_else(|| self.text.clone());
        self.finish(vec![Line::from(vec![s::warn("▲ "), s::warn(message)])]);
    }

    fn finish(&mut self, lines: Vec<Line<'static>>) {
        self.done = true;
        rt().remove(self.id, lines);
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        if !self.done {
            rt().remove(self.id, Vec::new());
        }
    }
}

/// Counted work with a bar, the items currently in flight and a free-form
/// note line. Built for uploads and downloads:
///
/// ```text
/// ⠹ Uploading  ━━━━━━━━━━━━━━━╺━━━━━━━━━━━━  212/412
///   ↑ assets/app.4f3a.js                    84.1 KB
///   ↑ img/hero.avif                          1.2 MB
///   32 uploaded · 180 reused
/// ```
pub struct Progress {
    id: u64,
    done: bool,
}

/// Handle for one in-flight item row of a [`Progress`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ItemId(u64);

pub fn progress(label: impl Into<String>, total: u64, direction: Direction) -> Progress {
    let id = next_id();
    rt().upsert(id, Node::progress(label.into(), total, direction));
    Progress { id, done: false }
}

impl Progress {
    fn update(&self, f: impl FnOnce(&mut live::ProgressState) + Send + 'static) {
        rt().update(self.id, move |node| {
            if let Node::Progress(state) = node {
                f(state);
            }
        });
    }

    pub fn set_label(&self, label: impl Into<String>) {
        let label = label.into();
        self.update(move |p| p.label = label);
    }

    pub fn set_total(&self, total: u64) {
        self.update(move |p| p.total = total);
    }

    /// Advance the counter by `n` finished items.
    pub fn advance(&self, n: u64) {
        self.update(move |p| p.done += n);
    }

    /// The muted line under the bar, e.g. `32 uploaded · 180 reused`.
    pub fn set_note(&self, note: impl Into<String>) {
        let note = note.into();
        self.update(move |p| p.note = note);
    }

    /// Show an item as in flight. `detail` is right-aligned (usually a size).
    pub fn start_item(&self, name: impl Into<String>, detail: impl Into<String>) -> ItemId {
        let item = next_id();
        let (name, detail) = (name.into(), detail.into());
        self.update(move |p| {
            p.items.push(live::Item {
                id: item,
                name,
                detail,
            })
        });
        ItemId(item)
    }

    pub fn finish_item(&self, item: ItemId) {
        self.update(move |p| p.items.retain(|i| i.id != item.0));
    }

    pub fn succeed(mut self, message: impl Into<String>) {
        self.finish(vec![glyph_line(s::ok("✓"), message.into())]);
    }

    pub fn fail(mut self, message: impl Into<String>) {
        self.finish(vec![glyph_line(s::danger("✗"), message.into())]);
    }

    fn finish(&mut self, lines: Vec<Line<'static>>) {
        self.done = true;
        rt().remove(self.id, lines);
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        if !self.done {
            rt().remove(self.id, Vec::new());
        }
    }
}

/// A long-lived status block, e.g. the `serve` dashboard. The first line gets
/// a status glyph (breathing dot, spinner or cross); the rest render as given.
/// In plain mode panels are invisible, so print anything important as well.
pub struct Panel {
    id: u64,
}

pub fn panel(status: PanelStatus, lines: Vec<Line<'static>>) -> Panel {
    let id = next_id();
    rt().upsert(id, Node::Panel { status, lines });
    Panel { id }
}

impl Panel {
    pub fn set(&self, status: PanelStatus, lines: Vec<Line<'static>>) {
        rt().upsert(self.id, Node::Panel { status, lines });
    }
}

impl Drop for Panel {
    fn drop(&mut self) {
        rt().remove(self.id, Vec::new());
    }
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by commands
// ---------------------------------------------------------------------------

/// `1536` -> `1.5 KB`. Binary units, at most two decimals, trailing zeros
/// dropped (`1 KB`, `1.25 MB`), matching the old CLI's output.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".into();
    }
    let exp = ((bytes as f64).ln() / 1024f64.ln()).floor() as usize;
    let exp = exp.min(UNITS.len() - 1);
    let value = bytes as f64 / 1024f64.powi(exp as i32);
    let rounded = format!("{value:.2}");
    let trimmed = rounded.trim_end_matches('0').trim_end_matches('.');
    format!("{trimmed} {}", UNITS[exp])
}

#[cfg(test)]
mod tests {
    use super::format_bytes;

    #[test]
    fn formats_bytes_like_the_old_cli() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(300 * 1024 * 1024), "300 MB");
        assert_eq!(format_bytes(1_234_567), "1.18 MB");
    }
}
