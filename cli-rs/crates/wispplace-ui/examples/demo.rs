//! Visual check for every live element: `cargo run -p wispplace-ui --example demo -- <scene>`.

use std::thread::sleep;
use std::time::Duration;

use wispplace_ui::{Choice, Direction, Line, PanelStatus, TextPrompt, s};

fn pause(ms: u64) {
    sleep(Duration::from_millis(ms));
}

fn deploy() {
    wispplace_ui::intro("deploy");
    let handle =
        wispplace_ui::text(TextPrompt::new("AT Protocol handle").placeholder("alice.bsky.social"));
    let site = wispplace_ui::text(
        TextPrompt::new("Site name")
            .placeholder("my-website")
            .validate(|v| {
                if v.is_empty() {
                    Err("Site name is required".into())
                } else {
                    Ok(())
                }
            }),
    );
    let _ = (handle, site);
    let spinner = wispplace_ui::spinner("Authenticating...");
    pause(600);
    spinner.succeed("Authenticated as did:plc:untyra7qun43gbecoft5cglc".to_owned());
    wispplace_ui::note(Line::from(vec![
        s::accent("Deploying "),
        s::accent_bold("my-blog"),
        s::accent(" from ./dist"),
    ]));
    let scan = wispplace_ui::spinner("Scanning directory...");
    pause(300);
    scan.succeed("Found 412 files (3.4 MB)".to_owned());
    let progress = wispplace_ui::progress("Uploading", 412, Direction::Up);
    let names = [
        "index.html",
        "assets/app.4f3a9c.js",
        "assets/vendor.81be2d.js",
        "img/hero.avif",
        "fonts/inter-var.woff2",
        "blog/2026/09/a-very-long-post-title-that-goes-on/index.html",
    ];
    let items: Vec<_> = names
        .iter()
        .map(|n| progress.start_item(*n, "84.1 KB"))
        .collect();
    progress.advance(212);
    progress.set_note("32 uploaded · 180 reused");
    pause(900);
    for item in items {
        progress.finish_item(item);
    }
    progress.advance(200);
    progress.succeed("Processed 412 files (32 uploaded, 380 reused)");
    wispplace_ui::warning("Site may not be cached by the hosting service.");
    wispplace_ui::out(Line::from(vec![s::muted(
        "  URI: at://did:plc:untyra7qun43gbecoft5cglc/place.wisp.fs/my-blog",
    )]));
    wispplace_ui::out(Line::from(vec![
        s::accent("  URL: "),
        s::link("https://sites.wisp.place/alice.test/my-blog"),
    ]));
    wispplace_ui::outro("Deployed successfully!");
}

fn menus() {
    wispplace_ui::intro("domain");
    let choices = vec![
        Choice::new("claim", "Claim custom domain").hint("example.com"),
        Choice::new("claim-subdomain", "Claim wisp subdomain").hint("alice.wisp.place"),
        Choice::new("status", "Get domain status"),
        Choice::new("add-site", "Map domain to site"),
        Choice::new("verify", "Verify domain"),
        Choice::new("delete", "Delete domain"),
    ];
    let _ = wispplace_ui::select("Choose domain action", choices);
    let _ = wispplace_ui::confirm("Delete site \"my-blog\" and unmap its domains?");
    let failing = wispplace_ui::spinner("Deleting site my-blog...");
    pause(400);
    failing.fail("Site my-blog not found".to_owned());
    wispplace_ui::error("XRPC request failed: RecordNotFound");
}

fn serve() {
    wispplace_ui::success("Pulled my-blog to .wisp-serve");
    let status = |state: &str| {
        vec![
            Line::from(vec![
                s::bold("serving my-blog"),
                s::muted("  →  "),
                s::link("http://127.0.0.1:8080"),
            ]),
            Line::from(vec![s::muted(format!(
                "firehose {state} · synced 12:04:11 · 142 files"
            ))]),
        ]
    };
    let panel = wispplace_ui::panel(PanelStatus::Live, status("connected"));
    for (code, path) in [
        (200, "/"),
        (200, "/assets/app.js"),
        (304, "/favicon.ico"),
        (404, "/nope"),
    ] {
        pause(250);
        let code_span = match code {
            200..=299 => s::ok(code.to_string()),
            300..=399 => s::info(code.to_string()),
            _ => s::warn(code.to_string()),
        };
        wispplace_ui::note(Line::from(vec![
            s::muted("  12:04:13  "),
            code_span,
            s::muted("  GET  "),
            s::plain(path),
            s::muted("  1.2ms"),
        ]));
    }
    panel.set(PanelStatus::Busy, status("re-pulling"));
    pause(700);
    panel.set(PanelStatus::Live, status("connected"));
    pause(1500);
}

fn main() {
    let _guard = wispplace_ui::init(wispplace_ui::Options::default());
    match std::env::args().nth(1).as_deref() {
        Some("menus") => menus(),
        Some("serve") => serve(),
        _ => deploy(),
    }
}
