//! Hyper HTTP edge. A body owns its stream permit until EOF, error, or cancellation.
use super::routing::{self, Body, Decision, FilesystemView, State};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Body as HttpBody, Frame, Incoming, SizeHint},
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::{
    fs::File,
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpListener,
    sync::{OwnedSemaphorePermit, RwLock, Semaphore},
    task::JoinSet,
};
use wisp_core::{
    pages::DirectoryEntry,
    redirects::{MAX_REDIRECT_FILE_BYTES, RedirectRule, parse_redirects_file_bytes},
};

pub const MAX_ACTIVE_FILE_STREAMS: usize = 64;
type ResponseBody = http_body_util::combinators::UnsyncBoxBody<Bytes, io::Error>;

struct LocalView<'a>(&'a Path);
impl LocalView<'_> {
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let root = self.0.canonicalize().ok()?;
        let resolved = root.join(path).canonicalize().ok()?;
        resolved.starts_with(root).then_some(resolved)
    }
}
impl FilesystemView for LocalView<'_> {
    fn is_file(&self, path: &str) -> bool {
        self.resolve(path).is_some_and(|p| p.is_file())
    }
    fn is_directory(&self, path: &str) -> bool {
        self.resolve(path).is_some_and(|p| p.is_dir())
    }
    fn entries(&self, path: &str) -> Vec<DirectoryEntry> {
        self.resolve(path)
            .and_then(|p| std::fs::read_dir(p).ok())
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|entry| {
                Some(DirectoryEntry {
                    name: entry.file_name().into_string().ok()?,
                    is_directory: entry.file_type().ok()?.is_dir(),
                })
            })
            .collect()
    }
}

pub fn load_redirects(root: &Path) -> Vec<RedirectRule> {
    use std::io::Read;
    let Some(path) = LocalView(root).resolve("_redirects") else {
        return vec![];
    };
    let Ok(file) = std::fs::File::open(path) else {
        return vec![];
    };
    let Ok(info) = file.metadata() else {
        return vec![];
    };
    if !info.is_file() || info.len() > MAX_REDIRECT_FILE_BYTES as u64 {
        return vec![];
    }
    let mut bytes = Vec::new();
    if file
        .take(MAX_REDIRECT_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return vec![];
    }
    parse_redirects_file_bytes(&bytes).unwrap_or_default()
}

struct FileBody {
    file: File,
    remaining: u64,
    permit: Option<OwnedSemaphorePermit>,
}
impl HttpBody for FileBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.remaining == 0 {
            self.permit.take();
            return Poll::Ready(None);
        }
        let mut storage = [0u8; 64 * 1024];
        let len = self.remaining.min(storage.len() as u64) as usize;
        let mut buffer = ReadBuf::new(&mut storage[..len]);
        match Pin::new(&mut self.file).poll_read(cx, &mut buffer) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => {
                self.remaining = 0;
                self.permit.take();
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(Ok(())) => {
                let bytes = buffer.filled();
                if bytes.is_empty() {
                    self.remaining = 0;
                    self.permit.take();
                    return Poll::Ready(Some(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "file changed while streaming",
                    ))));
                }
                self.remaining -= bytes.len() as u64;
                if self.remaining == 0 {
                    self.permit.take();
                }
                Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(bytes)))))
            }
        }
    }
    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

fn full(bytes: Bytes) -> ResponseBody {
    Full::new(bytes)
        .map_err(|never: Infallible| match never {})
        .boxed_unsync()
}
fn text(text: &str, status: u16, head: bool) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .header("Content-Length", text.len())
        .body(full(if head {
            Bytes::new()
        } else {
            Bytes::copy_from_slice(text.as_bytes())
        }))
        .expect("static response")
}

pub async fn respond(
    decision: Decision,
    root: &Path,
    head: bool,
    streams: Arc<Semaphore>,
) -> Response<ResponseBody> {
    let mut builder = Response::builder().status(decision.status);
    for (name, value) in decision.headers {
        builder = builder.header(name, value);
    }
    let body = match decision.body {
        Body::Empty => full(Bytes::new()),
        Body::Text(text, mime) => {
            builder = builder
                .header("Content-Type", mime)
                .header("Content-Length", text.len());
            full(if head {
                Bytes::new()
            } else {
                Bytes::from(text)
            })
        }
        Body::File(path) => {
            let Some(resolved) = LocalView(root).resolve(&path) else {
                return text("Not Found", 404, head);
            };
            // Admission precedes opening: saturation must not exhaust file descriptors.
            let permit = if head {
                None
            } else {
                match streams.try_acquire_owned() {
                    Ok(permit) => Some(permit),
                    Err(_) => {
                        let mut response = text("Too many active file streams", 503, false);
                        response
                            .headers_mut()
                            .insert("Retry-After", "1".parse().expect("static header"));
                        return response;
                    }
                }
            };
            let Ok(file) = File::open(&resolved).await else {
                return text("Not Found", 404, head);
            };
            let Ok(info) = file.metadata().await else {
                return text("Not Found", 404, head);
            };
            if !info.is_file() {
                return text("Not Found", 404, head);
            }
            builder = builder
                .header(
                    "Content-Type",
                    wisp_core::blob::mime_for(&resolved.to_string_lossy()),
                )
                .header("Content-Length", info.len())
                .header("Cache-Control", "no-cache");
            if head {
                full(Bytes::new())
            } else {
                FileBody {
                    file,
                    remaining: info.len(),
                    permit,
                }
                .boxed_unsync()
            }
        }
    };
    builder
        .body(body)
        .unwrap_or_else(|_| text("Invalid response header", 500, head))
}

async fn handle_request(
    request: Request<Incoming>,
    root: PathBuf,
    state: Arc<RwLock<State>>,
    streams: Arc<Semaphore>,
) -> Result<Response<ResponseBody>, Infallible> {
    let started = std::time::Instant::now();
    let head = request.method() == hyper::Method::HEAD;
    let snapshot = state.read().await.clone();
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let (log_method, log_path) = (method.clone(), path.clone());
    let decision_root = root.clone();
    let decision = tokio::task::spawn_blocking(move || {
        routing::decide(
            &method,
            &path,
            &query,
            &snapshot,
            &LocalView(&decision_root),
        )
    })
    .await;
    let response = match decision {
        Ok(decision) => respond(decision, &root, head, streams).await,
        Err(_) => text("Internal Server Error", 500, head),
    };
    super::log::request(
        response.status().as_u16(),
        &log_method,
        &log_path,
        started.elapsed(),
    );
    Ok(response)
}

struct IdleSocket {
    socket: tokio::net::TcpStream,
    deadline: Pin<Box<tokio::time::Sleep>>,
    idle: std::time::Duration,
}
impl IdleSocket {
    fn new(socket: tokio::net::TcpStream, idle: std::time::Duration) -> Self {
        Self {
            socket,
            deadline: Box::pin(tokio::time::sleep(idle)),
            idle,
        }
    }
    fn timed_out(&mut self, cx: &mut Context<'_>) -> bool {
        std::future::Future::poll(self.deadline.as_mut(), cx).is_ready()
    }
    fn progress(&mut self) {
        self.deadline
            .as_mut()
            .reset(tokio::time::Instant::now() + self.idle);
    }
}
impl AsyncRead for IdleSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.timed_out(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, buffer);
        if matches!(&result, Poll::Ready(Ok(()))) && buffer.filled().len() > before {
            self.progress();
        }
        result
    }
}
impl AsyncWrite for IdleSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.timed_out(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let result = Pin::new(&mut self.socket).poll_write(cx, bytes);
        if matches!(&result, Poll::Ready(Ok(count)) if *count > 0) {
            self.progress();
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.timed_out(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

async fn serve_connection(
    socket: tokio::net::TcpStream,
    root: PathBuf,
    state: Arc<RwLock<State>>,
    streams: Arc<Semaphore>,
) {
    let service = hyper::service::service_fn(move |request| {
        handle_request(request, root.clone(), state.clone(), streams.clone())
    });
    let mut http = hyper::server::conn::http1::Builder::new();
    http.timer(TokioTimer::new())
        .header_read_timeout(std::time::Duration::from_secs(10))
        .max_buf_size(32 * 1024);
    let socket = IdleSocket::new(socket, std::time::Duration::from_secs(30));
    let _ = http.serve_connection(TokioIo::new(socket), service).await;
}

pub async fn run(
    listener: TcpListener,
    root: PathBuf,
    state: Arc<RwLock<State>>,
) -> anyhow::Result<()> {
    let streams = Arc::new(Semaphore::new(MAX_ACTIVE_FILE_STREAMS));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                connections.spawn(serve_connection(
                    socket, root.clone(), state.clone(), streams.clone(),
                ));
            }
            _ = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::IdleSocket;
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    #[tokio::test]
    async fn timeout_tracks_inactivity_not_connection_lifetime() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = IdleSocket::new(socket, Duration::from_millis(100));
        for _ in 0..5 {
            tokio::time::sleep(Duration::from_millis(30)).await;
            client.write_all(b"x").await.unwrap();
            assert_eq!(socket.read_u8().await.unwrap(), b'x');
            socket.write_all(b"y").await.unwrap();
            assert_eq!(client.read_u8().await.unwrap(), b'y');
        }
        assert_eq!(
            socket.read_u8().await.unwrap_err().kind(),
            std::io::ErrorKind::TimedOut
        );
    }
}
