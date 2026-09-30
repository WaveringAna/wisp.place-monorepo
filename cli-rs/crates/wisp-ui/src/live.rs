//! Live-region elements and how they render. Rendering is a pure function of
//! the element, the available width and the animation clock.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::prompt::Prompt;
use crate::theme::{self, ColorSupport, accent_style, danger_style, muted_style, s};

/// One animation step, in milliseconds.
pub(crate) const TICK_MS: u64 = 80;

const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// In-flight rows a progress element shows before summarising the rest.
const MAX_VISIBLE_ITEMS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelStatus {
    /// Healthy and waiting for events: a slowly breathing dot.
    Live,
    /// Doing something right now: a spinner.
    Busy,
    /// Something is wrong: a red cross.
    Error,
    /// Nothing happening: a hollow dot.
    Idle,
}

/// Which way in-flight items are moving; picks the row glyph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
}

impl Direction {
    fn glyph(self) -> &'static str {
        match self {
            Self::Up => "↑ ",
            Self::Down => "↓ ",
        }
    }
}

pub(crate) struct Item {
    pub id: u64,
    pub name: String,
    pub detail: String,
}

pub(crate) struct ProgressState {
    pub label: String,
    pub total: u64,
    pub done: u64,
    pub note: String,
    pub items: Vec<Item>,
    pub direction: Direction,
}

pub(crate) enum Node {
    Spinner(String),
    Progress(ProgressState),
    Panel {
        status: PanelStatus,
        lines: Vec<Line<'static>>,
    },
    Prompt(Prompt),
}

impl Node {
    pub(crate) fn spinner(text: &str) -> Self {
        Self::Spinner(text.to_owned())
    }

    pub(crate) fn progress(label: String, total: u64, direction: Direction) -> Self {
        Self::Progress(ProgressState {
            label,
            total,
            done: 0,
            note: String::new(),
            items: Vec::new(),
            direction,
        })
    }

    pub(crate) fn animated(&self) -> bool {
        match self {
            Self::Spinner(_) | Self::Progress(_) => true,
            Self::Panel { status, .. } => matches!(status, PanelStatus::Live | PanelStatus::Busy),
            Self::Prompt(_) => false,
        }
    }

    pub(crate) fn render(&self, width: u16, tick: u64) -> Vec<Line<'static>> {
        match self {
            Self::Spinner(text) => {
                vec![Line::from(vec![
                    spinner_frame(tick),
                    Span::raw(" "),
                    Span::raw(text.clone()),
                ])]
            }
            Self::Progress(state) => render_progress(state, width, tick),
            Self::Panel { status, lines } => render_panel(*status, lines, tick),
            Self::Prompt(prompt) => prompt.render(),
        }
    }
}

fn spinner_frame(tick: u64) -> Span<'static> {
    s::accent(SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()])
}

/// A dot that fades between the accent and muted colours, one breath every
/// ~2.5s. Terminals without truecolor get a steady accent dot instead of an
/// abrupt two-colour blink.
fn breathing_dot(tick: u64) -> Span<'static> {
    let palette = theme::palette();
    let color = match (theme::support(), palette.accent, palette.muted) {
        (ColorSupport::TrueColor, Color::Rgb(ar, ag, ab), Color::Rgb(mr, mg, mb)) => {
            let period = 32.0;
            let phase = (tick as f64 % period) / period * std::f64::consts::TAU;
            let t = (phase.cos() + 1.0) / 2.0;
            let mix = |a: u8, m: u8| (m as f64 + (a as f64 - m as f64) * t).round() as u8;
            Color::Rgb(mix(ar, mr), mix(ag, mg), mix(ab, mb))
        }
        _ => palette.accent,
    };
    let style = if theme::support() == ColorSupport::None {
        Style::new()
    } else {
        Style::new().fg(color)
    };
    Span::styled("●", style)
}

fn render_panel(status: PanelStatus, lines: &[Line<'static>], tick: u64) -> Vec<Line<'static>> {
    let glyph = match status {
        PanelStatus::Live => breathing_dot(tick),
        PanelStatus::Busy => spinner_frame(tick),
        PanelStatus::Error => Span::styled("✗", danger_style()),
        PanelStatus::Idle => Span::styled("○", muted_style()),
    };
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let lead = if i == 0 {
                vec![glyph.clone(), Span::raw(" ")]
            } else {
                vec![Span::raw("  ")]
            };
            Line::from(
                lead.into_iter()
                    .chain(line.spans.iter().cloned())
                    .collect::<Vec<_>>(),
            )
        })
        .collect()
}

/// `━━━━━━╸━━━━━`: filled cells in the accent colour, a half-cell head, the
/// rest muted.
fn bar(fraction: f64, cells: usize) -> Vec<Span<'static>> {
    let exact = fraction.clamp(0.0, 1.0) * cells as f64;
    let full = exact.floor() as usize;
    let half = full < cells && exact - full as f64 >= 0.5;
    let rest = cells - full - usize::from(half);
    let mut spans = vec![Span::styled("━".repeat(full), accent_style())];
    if half {
        spans.push(Span::styled("╸", accent_style()));
    }
    spans.push(Span::styled(
        "━".repeat(rest),
        muted_style().add_modifier(Modifier::DIM),
    ));
    spans
}

/// Shorten `text` to `max` display columns, keeping its end (the file name is
/// the informative part of a path).
pub(crate) fn truncate_start(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_owned();
    }
    if max == 0 {
        return String::new();
    }
    let mut kept = Vec::new();
    let mut used = 1; // the ellipsis
    for c in text.chars().rev() {
        let w = c.width().unwrap_or(0);
        if used + w > max {
            break;
        }
        used += w;
        kept.push(c);
    }
    std::iter::once('…').chain(kept.into_iter().rev()).collect()
}

fn render_progress(state: &ProgressState, width: u16, tick: u64) -> Vec<Line<'static>> {
    let width = width as usize;
    let counter = format!("{}/{}", state.done, state.total);
    // "⠹ " + label + "  " + bar + "  " + counter
    let fixed = 2 + state.label.width() + 2 + 2 + counter.width();
    let cells = width.saturating_sub(fixed).clamp(0, 32);
    let fraction = if state.total == 0 {
        0.0
    } else {
        state.done as f64 / state.total as f64
    };

    let mut head = vec![
        spinner_frame(tick),
        Span::raw(" "),
        s::bold(state.label.clone()),
    ];
    if cells >= 8 {
        head.push(Span::raw("  "));
        head.extend(bar(fraction, cells));
    }
    head.push(Span::raw("  "));
    head.push(Span::raw(counter));
    let mut lines = vec![Line::from(head)];

    let name_room = width.saturating_sub(4);
    for item in state.items.iter().take(MAX_VISIBLE_ITEMS) {
        let detail_width = item.detail.width();
        let name_width = name_room.saturating_sub(detail_width + 2).min(48);
        let name = truncate_start(&item.name, name_width);
        let gap = name_width.saturating_sub(name.width()) + 2;
        lines.push(Line::from(vec![
            Span::raw("  "),
            s::accent(state.direction.glyph()),
            Span::raw(name),
            Span::raw(" ".repeat(gap)),
            s::muted(item.detail.clone()),
        ]));
    }
    let hidden = state.items.len().saturating_sub(MAX_VISIBLE_ITEMS);
    let note = match (hidden, state.note.is_empty()) {
        (0, true) => None,
        (0, false) => Some(state.note.clone()),
        (n, true) => Some(format!("+{n} more in flight")),
        (n, false) => Some(format!("+{n} more in flight · {}", state.note)),
    };
    if let Some(note) = note {
        lines.push(Line::from(vec![Span::raw("  "), s::muted(note)]));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn truncates_from_the_start() {
        assert_eq!(truncate_start("assets/js/app.js", 10), "…js/app.js");
        assert_eq!(truncate_start("short", 10), "short");
    }

    #[test]
    fn progress_shows_bar_items_and_note() {
        let mut state = ProgressState {
            label: "Uploading".into(),
            total: 10,
            done: 5,
            note: "3 uploaded · 2 reused".into(),
            items: Vec::new(),
            direction: Direction::Up,
        };
        for i in 0..6 {
            state.items.push(Item {
                id: i,
                name: format!("file-{i}.js"),
                detail: "1 KB".into(),
            });
        }
        let out = text(&render_progress(&state, 60, 0));
        assert!(out[0].contains("Uploading") && out[0].ends_with("5/10"));
        assert_eq!(out.len(), 1 + MAX_VISIBLE_ITEMS + 1);
        assert_eq!(out[5], "  +2 more in flight · 3 uploaded · 2 reused");
    }

    #[test]
    fn bar_fills_proportionally() {
        let cells: String = bar(0.5, 10).iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(cells, "━━━━━━━━━━");
        assert_eq!(bar(0.55, 10)[1].content, "╸");
    }
}
