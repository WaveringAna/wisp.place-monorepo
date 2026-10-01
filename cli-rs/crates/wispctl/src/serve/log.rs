use std::time::Duration;

use wispplace_ui::{Line, s};

/// Local wall-clock time, `HH:MM:SS`.
pub fn timestamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// One request line above the dashboard: `  12:04:13  200  GET  /about  1.2ms`.
pub fn request(status: u16, method: &str, path: &str, elapsed: Duration) {
    let code = status.to_string();
    let code = match status {
        200..=299 => s::ok(code),
        300..=399 => s::info(code),
        400..=499 => s::warn(code),
        _ => s::danger(code),
    };
    wispplace_ui::note(Line::from(vec![
        s::muted(format!("  {}  ", timestamp())),
        code,
        s::muted(format!("  {method:<4}  ")),
        s::plain(path.to_owned()),
        s::muted(format!("  {:.1}ms", elapsed.as_secs_f64() * 1000.0)),
    ]));
}
