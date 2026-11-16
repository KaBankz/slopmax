//! Inbound HTTP/1.1 on hyper: an accept loop with keep-alive and graceful
//! shutdown. Routing is the handler's business.
//!
//! A server listens on local TCP or, on unix, on the socket tailscaled
//! forwards the tailnet to. Each request carries the [`Channel`] it came in
//! on, which only the listener sets.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch;

use super::body::Body;
use slopmax_common::log;

pub type Request = http::Request<Incoming>;
pub type Response = http::Response<Body>;

/// How long a client may take to send its request headers.
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// How long shutdown waits for in-flight requests (long streams included).
pub const DRAIN: Duration = Duration::from_secs(10);

/// How a server stops taking connections, and how long what it has may
/// still take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// Idle connections close at once; requests under way get this long.
    Now(Duration),
    /// Another process took the socket over: no connection is closed under
    /// a client that may be about to send on it. Each answers what comes
    /// next with `Connection: close`, and ends after that or when its
    /// client closes it, within this long.
    HandedOver(Duration),
}

impl Stop {
    fn limit(self) -> Duration {
        match self {
            Self::Now(limit) | Self::HandedOver(limit) => limit,
        }
    }
}

/// The listener a request came in on, in its extensions. Only [`serve`]
/// sets it, so a handler can trust it where it cannot trust a header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// Local TCP: programs on this machine.
    Tcp,
    /// The unix socket tailscaled forwards the tailnet to.
    Tailnet,
}

/// Where a server accepts connections.
pub enum Listener {
    Tcp(TcpListener),
    /// The socket tailscaled forwards the tailnet to. Only root (tailscaled)
    /// and `owner` may connect; anyone else is refused.
    #[cfg(unix)]
    Tailnet {
        listener: UnixListener,
        owner: u32,
    },
}

impl From<TcpListener> for Listener {
    fn from(listener: TcpListener) -> Self {
        Listener::Tcp(listener)
    }
}

/// The tailnet listener on `listener`, open to root and the `owner` uid.
#[cfg(unix)]
pub fn tailnet(listener: UnixListener, owner: u32) -> Listener {
    Listener::Tailnet { listener, owner }
}

impl Listener {
    /// The next connection and its channel. `None` is a connection that
    /// was refused and dropped.
    async fn accept(&self) -> io::Result<Option<(Conn, Channel)>> {
        match self {
            Listener::Tcp(listener) => {
                let (stream, _) = listener.accept().await?;
                // Streamed answers are many small writes. Nagle's algorithm
                // would hold each until the client acknowledges the last,
                // and clients delay acknowledgments by up to 40 ms.
                let _ = stream.set_nodelay(true);
                Ok(Some((Conn::Tcp(stream), Channel::Tcp)))
            }
            #[cfg(unix)]
            Listener::Tailnet { listener, owner } => {
                let (stream, _) = listener.accept().await?;
                match stream.peer_cred() {
                    Ok(peer) if peer.uid() == 0 || peer.uid() == *owner => {
                        Ok(Some((Conn::Unix(stream), Channel::Tailnet)))
                    }
                    Ok(peer) => {
                        let uid = peer.uid();
                        log::warn!("refused a connection to the tailnet socket from uid {uid}");
                        Ok(None)
                    }
                    Err(e) => {
                        log::warn!("refused a connection to the tailnet socket: {e}");
                        Ok(None)
                    }
                }
            }
        }
    }
}

/// An accepted connection of either kind, so the connection code is
/// compiled once.
enum Conn {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl AsyncRead for Conn {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(inner) => Pin::new(inner).poll_read(cx, buf),
            #[cfg(unix)]
            Conn::Unix(inner) => Pin::new(inner).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Conn {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Conn::Tcp(inner) => Pin::new(inner).poll_write(cx, buf),
            #[cfg(unix)]
            Conn::Unix(inner) => Pin::new(inner).poll_write(cx, buf),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Conn::Tcp(inner) => Pin::new(inner).poll_write_vectored(cx, bufs),
            #[cfg(unix)]
            Conn::Unix(inner) => Pin::new(inner).poll_write_vectored(cx, bufs),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Conn::Tcp(inner) => inner.is_write_vectored(),
            #[cfg(unix)]
            Conn::Unix(inner) => inner.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(inner) => Pin::new(inner).poll_flush(cx),
            #[cfg(unix)]
            Conn::Unix(inner) => Pin::new(inner).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(inner) => Pin::new(inner).poll_shutdown(cx),
            #[cfg(unix)]
            Conn::Unix(inner) => Pin::new(inner).poll_shutdown(cx),
        }
    }
}

/// Serves `handler` on `listener` until `shutdown` completes, then lets
/// in-flight requests finish for a moment. Each request carries its
/// [`Channel`] in its extensions.
pub fn serve<H, F>(
    listener: impl Into<Listener>,
    handler: H,
    shutdown: impl Future<Output = ()>,
) -> impl Future<Output = ()>
where
    H: Fn(Request) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response> + Send + 'static,
{
    run(listener.into(), handler, async {
        shutdown.await;
        Stop::Now(DRAIN)
    })
}

/// Serves `handler` on `listener` until `shutdown` says how to stop, then
/// waits at most as long as it says for the connections to end. The
/// listener closes as soon as it stops taking connections, so none wait on
/// it for an answer that never comes; a process it was handed to keeps the
/// socket open and takes them instead.
pub fn serve_until<H, F>(
    listener: impl Into<Listener>,
    handler: H,
    shutdown: impl Future<Output = Stop>,
) -> impl Future<Output = ()>
where
    H: Fn(Request) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response> + Send + 'static,
{
    run(listener.into(), handler, shutdown)
}

/// [`serve_until`] on a listener of either kind: one server whichever it
/// is, compiled once for each handler.
async fn run<H, F>(listener: Listener, handler: H, shutdown: impl Future<Output = Stop>)
where
    H: Fn(Request) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response> + Send + 'static,
{
    // Each connection holds a receiver; the sender learns when all are gone.
    let (stop, stopping) = watch::channel(None::<Stop>);
    tokio::pin!(shutdown);
    let how = loop {
        let (stream, channel) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(Some(accepted)) => accepted,
                Ok(None) => continue,
                Err(e) => {
                    // Usually out of file descriptors: back off instead of spinning.
                    log::warn!("accepting a connection failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            how = &mut shutdown => break how,
        };
        let handler = handler.clone();
        let mut stopping = stopping.clone();
        let closing = stopping.clone();
        tokio::spawn(async move {
            let service = service_fn(move |mut request: Request| {
                request.extensions_mut().insert(channel);
                let response = handler(request);
                let closing = closing.clone();
                async move {
                    let mut response = response.await;
                    // Answered after a handover: the client's next request
                    // opens a connection, which the new process takes.
                    if matches!(*closing.borrow(), Some(Stop::HandedOver(_))) {
                        response.headers_mut().insert(
                            http::header::CONNECTION,
                            http::HeaderValue::from_static("close"),
                        );
                    }
                    Ok::<_, Infallible>(response)
                }
            });
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            tokio::pin!(connection);
            tokio::select! {
                _ = connection.as_mut() => {}
                _ = stopping.changed() => {
                    if !matches!(*stopping.borrow(), Some(Stop::HandedOver(_))) {
                        connection.as_mut().graceful_shutdown();
                    }
                    let _ = connection.await;
                }
            }
        });
    };
    drop(listener);
    drop(stopping);
    stop.send_replace(Some(how));
    let _ = tokio::time::timeout(how.limit(), stop.closed()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::full;
    use crate::client::Client;

    #[tokio::test]
    async fn serves_until_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hi", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(
            listener,
            |request: Request| async move {
                Response::new(full(format!(
                    "{} {}",
                    request.method(),
                    request.uri().path()
                )))
            },
            async {
                let _ = rx.await;
            },
        ));
        let client = Client::builder().build();
        let text = client.get(&url).send().await.unwrap().text().await.unwrap();
        assert_eq!(text, "GET /hi");
        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server stops")
            .unwrap();
    }

    /// Answers with the channel the request came in on.
    async fn echo_channel(request: Request) -> Response {
        Response::new(full(format!("{:?}", request.extensions().get::<Channel>())))
    }

    #[tokio::test]
    async fn marks_tcp_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        tokio::spawn(serve(listener, echo_channel, std::future::pending()));
        let client = Client::builder().build();
        let text = client.get(&url).send().await.unwrap().text().await.unwrap();
        assert_eq!(text, "Some(Tcp)");
    }

    #[cfg(unix)]
    mod tailnet {
        use std::os::unix::fs::MetadataExt;
        use std::path::{Path, PathBuf};

        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        use super::*;
        use crate::body::empty;

        /// A fresh directory for one test's socket, removed on drop.
        struct Dir(PathBuf);

        impl Dir {
            fn new(name: &str) -> Dir {
                let dir =
                    std::env::temp_dir().join(format!("slopmax-net-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                Dir(dir)
            }

            /// The uid this process creates files as.
            fn uid(&self) -> u32 {
                std::fs::metadata(&self.0).unwrap().uid()
            }

            fn socket(&self) -> PathBuf {
                self.0.join("s.sock")
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        const GET: &str = "GET /x HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n";

        /// Sends `request` raw and reads until the server closes. A refused
        /// connection may be closed before the request is written, or reset.
        async fn exchange(path: &Path, request: &str) -> String {
            let mut stream = UnixStream::connect(path).await.unwrap();
            let _ = stream.write_all(request.as_bytes()).await;
            let mut answer = Vec::new();
            let read = stream.read_to_end(&mut answer);
            let _ = tokio::time::timeout(Duration::from_secs(5), read)
                .await
                .expect("the server answers or closes");
            String::from_utf8(answer).unwrap()
        }

        #[tokio::test]
        async fn marks_tailnet_requests_from_the_owner() {
            let dir = Dir::new("owner");
            let listener = UnixListener::bind(dir.socket()).unwrap();
            let server = tailnet(listener, dir.uid());
            tokio::spawn(serve(server, echo_channel, std::future::pending()));
            let answer = exchange(&dir.socket(), GET).await;
            assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
            assert!(answer.ends_with("Some(Tailnet)"), "{answer}");
        }

        #[tokio::test]
        async fn refuses_other_users() {
            let dir = Dir::new("stranger");
            let uid = dir.uid();
            if uid == 0 {
                // Root is always let in, so a test as root has no stranger.
                return;
            }
            let listener = UnixListener::bind(dir.socket()).unwrap();
            let server = tailnet(listener, uid + 1);
            tokio::spawn(serve(server, echo_channel, std::future::pending()));
            assert_eq!(exchange(&dir.socket(), GET).await, "");
        }

        #[tokio::test]
        async fn upgrades_over_the_socket() {
            let dir = Dir::new("upgrade");
            let listener = UnixListener::bind(dir.socket()).unwrap();
            let handler = |mut request: Request| async move {
                let upgrading = hyper::upgrade::on(&mut request);
                tokio::spawn(async move {
                    let mut io = TokioIo::new(upgrading.await.unwrap());
                    io.write_all(b"upgraded").await.unwrap();
                    io.shutdown().await.unwrap();
                });
                http::Response::builder()
                    .status(http::StatusCode::SWITCHING_PROTOCOLS)
                    .header("connection", "upgrade")
                    .header("upgrade", "test")
                    .body(empty())
                    .unwrap()
            };
            let server = tailnet(listener, dir.uid());
            tokio::spawn(serve(server, handler, std::future::pending()));
            let answer = exchange(
                &dir.socket(),
                "GET /ws HTTP/1.1\r\nHost: a\r\nConnection: upgrade\r\nUpgrade: test\r\n\r\n",
            )
            .await;
            assert!(answer.starts_with("HTTP/1.1 101"), "{answer}");
            assert!(answer.ends_with("\r\n\r\nupgraded"), "{answer}");
        }
    }
}

/// The program listening on TCP `port`, as `name (pid N)`, when the
/// system says. Used to explain a port that is already taken.
pub fn port_holder(port: u16) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        // Listening sockets of that port, by inode…
        let inodes: Vec<String> = ["/proc/net/tcp", "/proc/net/tcp6"]
            .iter()
            .filter_map(|table| std::fs::read_to_string(table).ok())
            .flat_map(|text| {
                text.lines()
                    .skip(1)
                    .filter_map(|line| {
                        let fields: Vec<&str> = line.split_whitespace().collect();
                        let local = u16::from_str_radix(fields.get(1)?.rsplit(':').next()?, 16);
                        let listening = *fields.get(3)? == "0A";
                        (local == Ok(port) && listening)
                            .then(|| fields.get(9).map(|i| i.to_string()))?
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        if inodes.is_empty() {
            return None;
        }
        // …and the process holding one of them.
        for entry in std::fs::read_dir("/proc").ok()?.flatten() {
            let pid = entry.file_name().to_string_lossy().into_owned();
            if !pid.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                let target = target.to_string_lossy();
                if inodes
                    .iter()
                    .any(|inode| target == format!("socket:[{inode}]").as_str())
                {
                    let name =
                        std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
                    return Some(format!("{} (pid {pid})", name.trim()));
                }
            }
        }
        // The socket belongs to a process this user cannot see.
        Some("another user's program".into())
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let pid = text.lines().find_map(|l| l.strip_prefix('p'))?;
        let name = text
            .lines()
            .find_map(|l| l.strip_prefix('c'))
            .unwrap_or("a program");
        Some(format!("{name} (pid {pid})"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = port;
        None
    }
}

#[cfg(test)]
mod port_tests {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use super::*;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn names_the_program_holding_a_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let holder = port_holder(port).unwrap();
        assert!(
            holder.contains(&format!("pid {}", std::process::id())),
            "{holder}"
        );
        drop(listener);
        assert_eq!(port_holder(port), None);
    }
}
