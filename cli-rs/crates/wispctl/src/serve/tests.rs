use super::{
    http::{MAX_ACTIVE_FILE_STREAMS, load_redirects, respond},
    routing::{Body, Decision, FilesystemView, Settings, State, decide},
};
use http_body_util::BodyExt;
use std::collections::BTreeSet;
use std::sync::Arc;
use tokio::sync::Semaphore;
use wispplace_core::{
    pages::DirectoryEntry,
    redirects::{MAX_REDIRECT_FILE_BYTES, parse_redirects_file},
};

struct View {
    files: BTreeSet<String>,
    directories: BTreeSet<String>,
}
impl View {
    fn new(files: &[&str], dirs: &[&str]) -> Self {
        Self {
            files: files.iter().map(|p| (*p).into()).collect(),
            directories: dirs.iter().map(|p| (*p).into()).collect(),
        }
    }
}
impl FilesystemView for View {
    fn is_file(&self, path: &str) -> bool {
        self.files.contains(path)
    }
    fn is_directory(&self, path: &str) -> bool {
        self.directories.contains(path)
    }
    fn entries(&self, _: &str) -> Vec<DirectoryEntry> {
        vec![
            DirectoryEntry {
                name: "<hello>.txt".into(),
                is_directory: false,
            },
            DirectoryEntry {
                name: ".secret".into(),
                is_directory: false,
            },
        ]
    }
}
fn settings() -> Settings {
    Settings {
        directory_listing: false,
        clean_urls: true,
        spa_mode: None,
        custom_404: None,
        index_files: None,
    }
}
fn get(path: &str, state: &State, fs: &View) -> Decision {
    decide("GET", path, "", state, fs)
}

#[test]
fn routing_precedence_and_cli_overrides() {
    let fs = View::new(
        &[
            "index.html",
            "about.html",
            "app.html",
            "error.html",
            "404.html",
        ],
        &[""],
    );
    let mut state = State::default();
    assert_eq!(get("/", &state, &fs).body, Body::File("index.html".into()));
    assert_eq!(
        get("/about", &state, &fs).body,
        Body::File("about.html".into())
    );
    assert_eq!(
        get("/missing", &state, &fs).body,
        Body::File("404.html".into())
    );
    assert_eq!(get("/missing", &state, &fs).status, 404);
    let mut record = settings();
    record.spa_mode = Some("app.html".into());
    record.custom_404 = Some("error.html".into());
    state.settings = Some(record);
    assert_eq!(
        get("/missing", &state, &fs).body,
        Body::File("app.html".into())
    );
    state.spa_override = Some("".into());
    assert_eq!(
        get("/missing", &state, &fs).body,
        Body::File("error.html".into())
    );
    state.spa_override = Some("index.html".into());
    assert_eq!(
        get("/missing", &state, &fs).body,
        Body::File("index.html".into())
    );
    state.settings.as_mut().unwrap().clean_urls = false;
    assert_eq!(
        get("/about", &state, &fs).body,
        Body::File("index.html".into())
    );
}

#[test]
fn unsafe_request_and_configuration_paths_never_reach_filesystem() {
    let fs = View::new(&["secret", "404.html"], &[""]);
    let mut state = State::default();
    for path in [
        "/../secret",
        "/assets/../secret",
        "/assets%2f..%2fsecret",
        "/safe%00name",
        "/assets\\secret",
        "/C:/Windows/system.ini",
        "/assets/C:/stream",
        "/assets/file.",
        "/assets/file%20",
        "/%zz",
        "/%ff",
        "/%",
    ] {
        assert_eq!(get(path, &state, &fs).status, 400, "{path}");
    }
    let mut record = settings();
    record.spa_mode = Some("../secret".into());
    record.custom_404 = Some("../secret".into());
    record.index_files = Some(vec!["../secret".into()]);
    state.settings = Some(record);
    assert_eq!(get("/", &state, &fs).body, Body::File("404.html".into()));
    state.redirects = parse_redirects_file("/old /../secret 200");
    assert_eq!(get("/old", &state, &fs).status, 400);
}

#[test]
fn redirects_rewrites_and_custom_404() {
    let fs = View::new(&["target.html", "error.html"], &[]);
    let mut state = State {
        redirects: parse_redirects_file(
            "/old /new 301\n/rewrite /target.html 200\n/gone /error.html 404",
        ),
        ..Default::default()
    };
    let response = get("/old", &state, &fs);
    assert_eq!(response.status, 301);
    assert_eq!(response.headers, vec![("Location", "/new".into())]);
    assert_eq!(
        get("/rewrite", &state, &fs).body,
        Body::File("target.html".into())
    );
    assert_eq!(
        get("/gone", &state, &fs).body,
        Body::File("error.html".into())
    );
    assert_eq!(get("/gone", &state, &fs).status, 404);
    state.redirects = parse_redirects_file("/find q=hello /target.html 301");
    assert_eq!(
        decide("GET", "/find", "q=hello", &state, &fs).headers,
        vec![("Location", "/target.html?q=hello".into())]
    );
}

#[test]
fn listing_is_opt_in_and_index_takes_precedence() {
    let fs = View::new(&[], &[""]);
    let mut state = State {
        directory_listing_override: Some(true),
        ..Default::default()
    };
    let response = get("/", &state, &fs);
    assert_eq!(response.status, 200);
    let Body::Text(html, _) = response.body else {
        panic!("expected listing");
    };
    assert!(!html.contains(".secret"));
    assert!(html.contains("&lt;hello&gt;"));
    state.directory_listing_override = Some(false);
    assert_eq!(get("/", &state, &fs).status, 404);
    assert_eq!(
        get("/", &state, &View::new(&["index.htm"], &[""])).body,
        Body::File("index.htm".into())
    );
    let method = decide("POST", "/", "", &state, &fs);
    assert_eq!(method.status, 405);
    assert_eq!(method.headers, vec![("Allow", "GET, HEAD".into())]);
}

#[tokio::test]
async fn streaming_headers_head_and_permit_release() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("hello.txt"), "hello").unwrap();
    let streams = Arc::new(Semaphore::new(MAX_ACTIVE_FILE_STREAMS));
    let decision = || Decision {
        status: 200,
        headers: vec![],
        body: Body::File("hello.txt".into()),
    };
    let mut responses = Vec::new();
    for _ in 0..MAX_ACTIVE_FILE_STREAMS {
        responses.push(respond(decision(), temp.path(), false, streams.clone()).await);
    }
    let saturated = respond(decision(), temp.path(), false, streams.clone()).await;
    assert_eq!(saturated.status(), 503);
    assert_eq!(saturated.headers()["Retry-After"], "1");
    let head = respond(decision(), temp.path(), true, streams.clone()).await;
    assert_eq!(head.status(), 200);
    assert_eq!(head.headers()["Content-Length"], "5");
    assert_eq!(head.headers()["Content-Type"], "text/plain");
    assert_eq!(head.headers()["Cache-Control"], "no-cache");
    assert!(
        head.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    let get = responses.pop().unwrap();
    assert_eq!(get.headers()["Content-Length"], "5");
    assert_eq!(get.into_body().collect().await.unwrap().to_bytes(), "hello");
    assert_eq!(streams.available_permits(), 1);
    drop(responses);
    assert_eq!(streams.available_permits(), MAX_ACTIVE_FILE_STREAMS);
    let missing = Decision {
        status: 200,
        headers: vec![],
        body: Body::File("missing.txt".into()),
    };
    assert_eq!(
        respond(missing, temp.path(), false, streams.clone())
            .await
            .status(),
        404
    );
    assert_eq!(streams.available_permits(), MAX_ACTIVE_FILE_STREAMS);
}

#[test]
fn redirects_are_bounded_before_decoding() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("_redirects"),
        vec![b'a'; MAX_REDIRECT_FILE_BYTES + 1],
    )
    .unwrap();
    assert!(load_redirects(temp.path()).is_empty());
    std::fs::write(temp.path().join("_redirects"), b"/old /new 302").unwrap();
    assert_eq!(load_redirects(temp.path()).len(), 1);
}

#[tokio::test]
async fn live_hyper_server_serves_get_head_and_rejects_post() {
    crate::tls::install_crypto_provider();
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("hello.txt"), "hello").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hello.txt", listener.local_addr().unwrap());
    let server = tokio::spawn(super::http::run(
        listener,
        temp.path().to_owned(),
        Arc::new(tokio::sync::RwLock::new(State::default())),
    ));
    let client = reqwest::Client::new();
    let get = client.get(&url).send().await.unwrap();
    assert_eq!(get.status(), 200);
    assert_eq!(get.headers()["content-length"], "5");
    assert_eq!(get.text().await.unwrap(), "hello");
    let head = client.head(&url).send().await.unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(head.headers()["content-length"], "5");
    assert_eq!(head.text().await.unwrap(), "");
    let post = client.post(&url).body("ignored").send().await.unwrap();
    assert_eq!(post.status(), 405);
    assert_eq!(post.headers()["allow"], "GET, HEAD");
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn shortened_file_releases_permit_on_stream_error() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("changing.txt");
    std::fs::write(&path, vec![b'x'; 100]).unwrap();
    let streams = Arc::new(Semaphore::new(1));
    let decision = Decision {
        status: 200,
        headers: vec![],
        body: Body::File("changing.txt".into()),
    };
    let response = respond(decision, temp.path(), false, streams.clone()).await;
    assert_eq!(streams.available_permits(), 0);
    std::fs::write(&path, []).unwrap();
    assert!(response.into_body().collect().await.is_err());
    assert_eq!(streams.available_permits(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_cannot_read_outside_cache() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        root.path().join("escape.txt"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("escape-dir")).unwrap();
    let streams = Arc::new(Semaphore::new(1));
    for path in ["escape.txt", "escape-dir/secret.txt"] {
        let decision = Decision {
            status: 200,
            headers: vec![],
            body: Body::File(path.into()),
        };
        assert_eq!(
            respond(decision, root.path(), false, streams.clone())
                .await
                .status(),
            404
        );
    }
    assert_eq!(streams.available_permits(), 1);
}
