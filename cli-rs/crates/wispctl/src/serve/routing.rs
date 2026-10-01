//! Request decisions over a read-only filesystem view; no network or terminal effects.
use wispplace_core::{
    pages::{DirectoryEntry, generate_404_page, generate_directory_listing},
    redirects::{MatchRedirectContext, RedirectRule, match_redirect_rule, parse_query_string},
};

#[derive(Clone, Debug)]
pub struct Settings {
    pub directory_listing: bool,
    pub clean_urls: bool,
    pub spa_mode: Option<String>,
    pub custom_404: Option<String>,
    pub index_files: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub struct State {
    pub settings: Option<Settings>,
    pub redirects: Vec<RedirectRule>,
    pub spa_override: Option<String>,
    pub directory_listing_override: Option<bool>,
}

pub trait FilesystemView {
    fn is_file(&self, path: &str) -> bool;
    fn is_directory(&self, path: &str) -> bool;
    fn entries(&self, path: &str) -> Vec<DirectoryEntry>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum Body {
    File(String),
    Text(String, &'static str),
    Empty,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Decision {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

impl Decision {
    fn file(path: String, status: u16) -> Self {
        Self {
            status,
            headers: vec![],
            body: Body::File(path),
        }
    }
    fn text(text: impl Into<String>, status: u16, mime: &'static str) -> Self {
        Self {
            status,
            headers: vec![],
            body: Body::Text(text.into(), mime),
        }
    }
}

fn configured_path(path: &str) -> Option<String> {
    wispplace_core::path::normalize_configured_site_path(path).map(str::to_owned)
}

fn join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.into()
    } else {
        format!("{}/{child}", parent.trim_end_matches('/'))
    }
}

pub fn decide(
    method: &str,
    encoded_path: &str,
    query: &str,
    state: &State,
    fs: &impl FilesystemView,
) -> Decision {
    if method != "GET" && method != "HEAD" {
        let mut response = Decision::text("Method Not Allowed", 405, "text/plain");
        response.headers.push(("Allow", "GET, HEAD".into()));
        return response;
    }
    let Some(mut path) = wispplace_core::path::decode_serve_request_path(encoded_path) else {
        return Decision::text("Invalid path", 400, "text/plain");
    };
    let context = MatchRedirectContext {
        query_params: parse_query_string(&format!("?{}", query.trim_start_matches('?'))),
        ..Default::default()
    };
    if let Some(matched) = match_redirect_rule(&path, &state.redirects, Some(&context)) {
        match matched.status {
            200 => {
                let rewritten = wispplace_core::path::normalize_rewrite_path(&matched.target_path);
                let Some(rewritten) = rewritten else {
                    return Decision::text("Invalid rewrite path", 400, "text/plain");
                };
                path = rewritten;
            }
            301 | 302 | 307 | 308 => {
                return Decision {
                    status: matched.status,
                    headers: vec![("Location", matched.target_path)],
                    body: Body::Empty,
                };
            }
            404 => {
                if let Some(target) =
                    configured_path(&matched.target_path).filter(|p| fs.is_file(p))
                {
                    return Decision::file(target, 404);
                }
            }
            _ => {}
        }
    }
    let path = path.trim_start_matches('/');
    let settings = state.settings.as_ref();
    let directory_listing = state
        .directory_listing_override
        .unwrap_or_else(|| settings.is_some_and(|s| s.directory_listing));
    if fs.is_directory(path) {
        let defaults = vec!["index.html".into(), "index.htm".into()];
        let indices = settings
            .and_then(|s| s.index_files.as_ref())
            .unwrap_or(&defaults);
        for index in indices {
            if let Some(index) = configured_path(index) {
                let candidate = join(path, &index);
                if fs.is_file(&candidate) {
                    return Decision::file(candidate, 200);
                }
            }
        }
        if directory_listing {
            let entries = fs
                .entries(path)
                .into_iter()
                .filter(|e| !e.name.starts_with('.'))
                .collect::<Vec<_>>();
            return Decision::text(
                generate_directory_listing(path.trim_end_matches('/'), &entries),
                200,
                "text/html",
            );
        }
    }
    if fs.is_file(path) {
        return Decision::file(path.into(), 200);
    }
    if settings.is_none_or(|s| s.clean_urls) {
        for candidate in [format!("{path}.html"), join(path, "index.html")] {
            if fs.is_file(&candidate) {
                return Decision::file(candidate, 200);
            }
        }
    }
    let spa = state
        .spa_override
        .as_ref()
        .or_else(|| settings.and_then(|s| s.spa_mode.as_ref()));
    if let Some(spa) = spa
        .and_then(|p| configured_path(p))
        .filter(|p| fs.is_file(p))
    {
        return Decision::file(spa, 200);
    }
    let custom = settings
        .and_then(|s| s.custom_404.as_ref())
        .and_then(|p| configured_path(p));
    for candidate in custom
        .into_iter()
        .chain(["404.html".into(), "not_found.html".into()])
    {
        if fs.is_file(&candidate) {
            return Decision::file(candidate, 404);
        }
    }
    Decision::text(generate_404_page(), 404, "text/html")
}
