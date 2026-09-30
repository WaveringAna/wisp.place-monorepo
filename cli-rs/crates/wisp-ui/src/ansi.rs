//! Writing styled lines straight to a stream, for output that is not part of
//! the live region (no renderer running, or stdout redirected).

use std::fmt::Write as _;

use crossterm::style::{Attribute, Color as CtColor, Stylize};
use ratatui::style::{Color, Modifier};
use ratatui::text::Line;

fn to_crossterm(color: Color) -> Option<CtColor> {
    Some(match color {
        Color::Reset => return None,
        Color::Black => CtColor::Black,
        Color::Red => CtColor::DarkRed,
        Color::Green => CtColor::DarkGreen,
        Color::Yellow => CtColor::DarkYellow,
        Color::Blue => CtColor::DarkBlue,
        Color::Magenta => CtColor::DarkMagenta,
        Color::Cyan => CtColor::DarkCyan,
        Color::Gray => CtColor::Grey,
        Color::DarkGray => CtColor::DarkGrey,
        Color::LightRed => CtColor::Red,
        Color::LightGreen => CtColor::Green,
        Color::LightYellow => CtColor::Yellow,
        Color::LightBlue => CtColor::Blue,
        Color::LightMagenta => CtColor::Magenta,
        Color::LightCyan => CtColor::Cyan,
        Color::White => CtColor::White,
        Color::Rgb(r, g, b) => CtColor::Rgb { r, g, b },
        Color::Indexed(i) => CtColor::AnsiValue(i),
    })
}

/// Render a line with ANSI escapes when `styled`, as plain text otherwise.
pub(crate) fn render(line: &Line<'_>, styled: bool) -> String {
    if !styled {
        return line.to_string();
    }
    let mut out = String::new();
    for span in &line.spans {
        let style = line.style.patch(span.style);
        let mut content = span.content.as_ref().stylize();
        if let Some(fg) = style.fg.and_then(to_crossterm) {
            content = content.with(fg);
        }
        let attributes = [
            (Modifier::BOLD, Attribute::Bold),
            (Modifier::DIM, Attribute::Dim),
            (Modifier::ITALIC, Attribute::Italic),
            (Modifier::UNDERLINED, Attribute::Underlined),
            (Modifier::REVERSED, Attribute::Reverse),
            (Modifier::CROSSED_OUT, Attribute::CrossedOut),
        ];
        for (modifier, attribute) in attributes {
            if style.add_modifier.contains(modifier) {
                content = content.attribute(attribute);
            }
        }
        let _ = write!(out, "{content}");
    }
    out
}
