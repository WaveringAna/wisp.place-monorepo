//! Colour palette and span helpers.
//!
//! Colours come from the wisp.place web palette, lifted to a lightness that
//! reads on both dark and light terminals. Terminals without truecolor get the
//! nearest ANSI colour so user themes still apply, and `NO_COLOR` turns every
//! colour off while keeping bold/dim emphasis.

use std::sync::OnceLock;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorSupport {
    None,
    Ansi,
    TrueColor,
}

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub accent: Color,
    pub secondary: Color,
    pub success: Color,
    pub danger: Color,
    pub warning: Color,
    pub info: Color,
    pub muted: Color,
}

impl Palette {
    pub const fn for_support(support: ColorSupport) -> Self {
        match support {
            ColorSupport::TrueColor => Self {
                accent: Color::Rgb(0xea, 0x89, 0xa1),
                secondary: Color::Rgb(0xa9, 0x98, 0xdd),
                success: Color::Rgb(0x4c, 0xb8, 0x6a),
                danger: Color::Rgb(0xec, 0x5b, 0x57),
                warning: Color::Rgb(0xe3, 0xad, 0x4b),
                info: Color::Rgb(0x4f, 0xa8, 0xe1),
                muted: Color::Rgb(0x84, 0x85, 0x92),
            },
            ColorSupport::Ansi => Self {
                accent: Color::Magenta,
                secondary: Color::LightBlue,
                success: Color::Green,
                danger: Color::Red,
                warning: Color::Yellow,
                info: Color::Cyan,
                muted: Color::DarkGray,
            },
            ColorSupport::None => Self {
                accent: Color::Reset,
                secondary: Color::Reset,
                success: Color::Reset,
                danger: Color::Reset,
                warning: Color::Reset,
                info: Color::Reset,
                muted: Color::Reset,
            },
        }
    }
}

fn env_is(name: &str, pred: impl Fn(&str) -> bool) -> bool {
    std::env::var(name).is_ok_and(|v| pred(&v))
}

pub fn detect_color_support() -> ColorSupport {
    if env_is("NO_COLOR", |v| !v.is_empty()) || env_is("TERM", |v| v == "dumb") {
        return ColorSupport::None;
    }
    let truecolor = env_is("COLORTERM", |v| v == "truecolor" || v == "24bit")
        || env_is("TERM_PROGRAM", |v| {
            matches!(v, "iTerm.app" | "WezTerm" | "ghostty" | "vscode" | "Hyper")
        })
        || env_is("WT_SESSION", |_| true);
    if truecolor {
        ColorSupport::TrueColor
    } else {
        ColorSupport::Ansi
    }
}

static SUPPORT: OnceLock<ColorSupport> = OnceLock::new();

pub(crate) fn set_support(support: ColorSupport) {
    let _ = SUPPORT.set(support);
}

pub fn support() -> ColorSupport {
    *SUPPORT.get_or_init(detect_color_support)
}

pub fn palette() -> Palette {
    Palette::for_support(support())
}

fn fg(color: Color) -> Style {
    if support() == ColorSupport::None {
        Style::new()
    } else {
        Style::new().fg(color)
    }
}

pub fn accent_style() -> Style {
    fg(palette().accent)
}
pub fn muted_style() -> Style {
    match support() {
        ColorSupport::None => Style::new().add_modifier(Modifier::DIM),
        _ => fg(palette().muted),
    }
}
pub fn success_style() -> Style {
    fg(palette().success)
}
pub fn danger_style() -> Style {
    fg(palette().danger)
}
pub fn warning_style() -> Style {
    fg(palette().warning)
}
pub fn info_style() -> Style {
    fg(palette().info)
}
pub fn secondary_style() -> Style {
    fg(palette().secondary)
}

/// Span constructors so callers can build lines without touching styles.
pub mod s {
    use super::*;
    use std::borrow::Cow;

    type Text = Cow<'static, str>;

    pub fn plain(text: impl Into<Text>) -> Span<'static> {
        Span::raw(text.into())
    }
    pub fn bold(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), Style::new().add_modifier(Modifier::BOLD))
    }
    pub fn accent(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), accent_style())
    }
    pub fn accent_bold(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), accent_style().add_modifier(Modifier::BOLD))
    }
    pub fn secondary(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), secondary_style())
    }
    pub fn muted(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), muted_style())
    }
    pub fn ok(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), success_style())
    }
    pub fn warn(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), warning_style())
    }
    pub fn danger(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), danger_style())
    }
    pub fn info(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), info_style())
    }
    /// A URL or other value the user may want to copy.
    pub fn link(text: impl Into<Text>) -> Span<'static> {
        Span::styled(text.into(), info_style().add_modifier(Modifier::UNDERLINED))
    }
}
