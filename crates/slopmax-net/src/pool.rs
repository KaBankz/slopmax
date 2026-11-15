//! Keep-alive HTTP/1.1 connections, kept per origin for the next request.
//!
//! A connection goes back on its origin's list as soon as its response
//! starts, and a request takes it again only once it is ready, its last
//! response read to the end. Asking that when a request needs one, rather
//! than waiting on it in a task, keeps a request on a kept connection free
//! of tasks and channels of its own. One task per pool, alive while any
//! connection is kept, watches them: it wakes as a response ends, to start
//! that connection's idle clock then, and when one has been unused for a
//! minute, to close it, as hyper-util's pool did.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::Bytes;
use http::header::HOST;
use http::uri::{Authority, Parts, Scheme};
use http::{HeaderValue, Request, Response, StatusCode, Uri};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::client::conn::http1::{self, SendRequest};
use hyper::rt::{Read, Write};
use tokio::time::Instant;
use tower_service::Service;

use crate::body::BoxError;

type Sender = SendRequest<Full<Bytes>>;

/// How long a connection may sit unused before it is closed.
const IDLE: Duration = Duration::from_secs(60);

/// Opens connections with `C` and keeps them for reuse.
pub(crate) struct Pool<C> {
    connector: C,
    kept: Arc<Kept>,
}

#[derive(Default)]
struct Kept {
    origins: Mutex<Origins>,
    /// Whether the task that watches the connections runs.
    sweeping: AtomicBool,
}

#[derive(Default)]
struct Origins {
    list: Vec<Origin>,
    /// The watching task, woken when a connection is kept so it watches
    /// that one too.
    watcher: Option<Waker>,
}

impl std::ops::Deref for Origins {
    type Target = Vec<Origin>;
    fn deref(&self) -> &Vec<Origin> {
        &self.list
    }
}

impl std::ops::DerefMut for Origins {
    fn deref_mut(&mut self) -> &mut Vec<Origin> {
        &mut self.list
    }
}

/// One server's connections.
struct Origin {
    scheme: Scheme,
    authority: String,
    /// The `Host` header its requests carry, made once.
    host: HeaderValue,
    conns: Vec<Conn>,
}

struct Conn {
    sender: Sender,
    /// Since when it has had nothing to do: from when its last response
    /// ended, as the watching task sees it end. None while it is busy.
    since: Option<Instant>,
}

impl<C> Pool<C>
where
    C: Service<Uri> + Clone + Send + 'static,
    C::Response: Read + Write + Unpin + Send + 'static,
    C::Future: Send,
    C::Error: Into<BoxError>,
{
    pub(crate) fn new(connector: C) -> Self {
        Self {
            connector,
            kept: Arc::default(),
        }
    }

    /// Sends `request`, whose URI is absolute, on a kept connection to its
    /// origin, or on a new one.
    pub(crate) async fn send(
        &self,
        mut request: Request<Full<Bytes>>,
    ) -> Result<Response<Incoming>, BoxError> {
        let uri = std::mem::take(request.uri_mut()).into_parts();
        let (Some(scheme), Some(authority)) = (uri.scheme, uri.authority) else {
            return Err("the URL has no scheme or host".into());
        };
        // Sent in origin form, as to the server itself.
        *request.uri_mut() = match uri.path_and_query {
            Some(path) if path.as_str() != "/" => {
                let mut parts = Parts::default();
                parts.path_and_query = Some(path);
                Uri::from_parts(parts).expect("a path alone is a valid URI")
            }
            _ => Uri::default(),
        };
        let (mut kept, host) = self.kept.checkout(&scheme, &authority, Instant::now());
        request.headers_mut().entry(HOST).or_insert(host);
        loop {
            let reused = kept.is_some();
            let mut sender = match kept.take() {
                Some(sender) => sender,
                None => self.connect(&scheme, &authority).await?,
            };
            match sender.try_send_request(request).await {
                Ok(response) => {
                    // A connection handed over to another protocol is not
                    // kept for HTTP.
                    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
                        self.kept.checkin(&scheme, &authority, sender);
                    }
                    return Ok(response);
                }
                Err(mut failed) => match failed.take_message() {
                    // A kept connection the server closed before the
                    // request went out: it goes out on another.
                    Some(unsent) if reused => {
                        request = unsent;
                        kept = self.kept.checkout(&scheme, &authority, Instant::now()).0;
                    }
                    _ => return Err(failed.into_error().into()),
                },
            }
        }
    }

    /// A new connection to the origin, ready for a request.
    async fn connect(&self, scheme: &Scheme, authority: &Authority) -> Result<Sender, BoxError> {
        let dst = Uri::builder()
            .scheme(scheme.clone())
            .authority(authority.clone())
            .path_and_query("/")
            .build()?;
        let mut connector = self.connector.clone();
        std::future::poll_fn(|cx| connector.poll_ready(cx))
            .await
            .map_err(Into::into)?;
        let io = connector.call(dst).await.map_err(Into::into)?;
        let (mut sender, connection) = http1::Builder::new().handshake(io).await?;
        tokio::spawn(async move {
            // Its errors reach the request it was serving.
            let _ = connection.with_upgrades().await;
        });
        sender.ready().await?;
        Ok(sender)
    }
}

impl Kept {
    fn lock(&self) -> MutexGuard<'_, Origins> {
        self.origins.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A kept connection to the origin that is ready for a request, if
    /// there is one, and the `Host` header for it.
    fn checkout(
        &self,
        scheme: &Scheme,
        authority: &Authority,
        now: Instant,
    ) -> (Option<Sender>, HeaderValue) {
        let mut origins = self.lock();
        let at = origins.iter().position(|o| o.is(scheme, authority));
        let origin = match at {
            Some(at) => &mut origins[at],
            None => {
                origins.push(Origin::new(scheme, authority));
                origins.last_mut().expect("pushed above")
            }
        };
        origin.prune(now);
        // The one used last is the likeliest to be open still.
        let ready = origin.conns.iter().rposition(|c| c.sender.is_ready());
        let sender = ready.map(|at| origin.conns.remove(at).sender);
        (sender, origin.host.clone())
    }

    /// Keeps a connection whose response has started, for when it is done.
    fn checkin(self: &Arc<Self>, scheme: &Scheme, authority: &Authority, sender: Sender) {
        if sender.is_closed() {
            return;
        }
        // Its response has only started; the clock starts once it is read.
        let conn = Conn {
            sender,
            since: None,
        };
        let watcher = {
            let mut origins = self.lock();
            match origins.iter_mut().find(|o| o.is(scheme, authority)) {
                Some(origin) => origin.conns.push(conn),
                None => {
                    let mut origin = Origin::new(scheme, authority);
                    origin.conns.push(conn);
                    origins.push(origin);
                }
            }
            origins.watcher.take()
        };
        if self.sweeping.swap(true, Ordering::AcqRel) {
            // A task watches already: it is to watch this one as well.
            if let Some(watcher) = watcher {
                watcher.wake();
            }
            return;
        }
        self.watch();
    }

    /// Starts the task that watches the kept connections. It stops once
    /// none is kept, or the pool is gone.
    fn watch(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.sweeping.store(false, Ordering::Release);
            return;
        };
        let kept = Arc::downgrade(self);
        runtime.spawn(async move {
            let mut due = std::pin::pin!(tokio::time::sleep(IDLE));
            std::future::poll_fn(|cx| {
                let Some(kept) = kept.upgrade() else {
                    return Poll::Ready(());
                };
                loop {
                    let now = Instant::now();
                    let mut origins = kept.lock();
                    let mut next: Option<Instant> = None;
                    for origin in origins.iter_mut() {
                        origin.watch(cx, now, &mut next);
                    }
                    origins.retain(|o| !o.conns.is_empty());
                    let Some(next) = next.or(origins.is_empty().then_some(now)) else {
                        // Every one is busy: it wakes as one is done.
                        origins.watcher = Some(cx.waker().clone());
                        return Poll::Pending;
                    };
                    if origins.is_empty() {
                        // Under the lock, so a connection kept meanwhile
                        // starts another task.
                        kept.sweeping.store(false, Ordering::Release);
                        return Poll::Ready(());
                    }
                    origins.watcher = Some(cx.waker().clone());
                    drop(origins);
                    due.as_mut().reset(next);
                    if due.as_mut().poll(cx).is_pending() {
                        return Poll::Pending;
                    }
                }
            })
            .await;
        });
    }
}

impl Origin {
    fn new(scheme: &Scheme, authority: &Authority) -> Self {
        // The port only when it is not the scheme's own.
        let default = if *scheme == Scheme::HTTPS { 443 } else { 80 };
        let host = match authority.port() {
            Some(port) if port.as_u16() != default => format!("{}:{port}", authority.host()),
            _ => authority.host().to_owned(),
        };
        Self {
            scheme: scheme.clone(),
            authority: authority.as_str().to_owned(),
            host: HeaderValue::from_str(&host).expect("a URI's host is a valid header"),
            conns: Vec::new(),
        }
    }

    fn is(&self, scheme: &Scheme, authority: &Authority) -> bool {
        self.scheme == *scheme && self.authority.eq_ignore_ascii_case(authority.as_str())
    }

    /// For the watching task: starts the clock of each connection whose
    /// response has ended, asks to be woken when a busy one is done, drops
    /// those closed or unused too long, and notes in `next` when the
    /// soonest of the rest is due to close.
    fn watch(&mut self, cx: &mut Context<'_>, now: Instant, next: &mut Option<Instant>) {
        self.conns
            .retain_mut(|conn| match conn.sender.poll_ready(cx) {
                Poll::Ready(Ok(())) => {
                    let since = *conn.since.get_or_insert(now);
                    let due = since + IDLE;
                    if due <= now {
                        return false;
                    }
                    *next = Some(next.map_or(due, |n| n.min(due)));
                    true
                }
                Poll::Ready(Err(_)) => false,
                Poll::Pending => {
                    conn.since = None;
                    true
                }
            });
    }

    /// Drops the connections that closed and those unused too long. One
    /// still busy with its last response is not unused.
    fn prune(&mut self, now: Instant) {
        self.conns.retain_mut(|conn| {
            if conn.sender.is_closed() {
                return false;
            }
            if !conn.sender.is_ready() {
                conn.since = None;
                return true;
            }
            let since = *conn.since.get_or_insert(now);
            now.duration_since(since) < IDLE
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use http_body_util::BodyExt;
    use hyper_util::rt::TokioIo;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    /// Plain TCP to the address in the URI.
    #[derive(Clone)]
    struct Plain;

    impl Service<Uri> for Plain {
        type Response = TokioIo<TcpStream>;
        type Error = BoxError;
        type Future =
            std::pin::Pin<Box<dyn Future<Output = Result<TokioIo<TcpStream>, BoxError>> + Send>>;

        fn poll_ready(
            &mut self,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), BoxError>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn call(&mut self, dst: Uri) -> Self::Future {
            Box::pin(async move {
                let addr = dst.authority().expect("absolute").as_str().to_owned();
                Ok(TokioIo::new(TcpStream::connect(addr).await?))
            })
        }
    }

    /// A server answering each request with `ok`, closing each connection
    /// after `per_connection` answers. Counts the connections it accepts.
    async fn server(per_connection: usize) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&accepted);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    for _ in 0..per_connection {
                        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            let mut chunk = [0; 1024];
                            match stream.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                            }
                        }
                        // `/slow` answers its body a moment after its head.
                        let slow = buf.starts_with(b"GET /slow ");
                        buf.clear();
                        let head = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n";
                        if stream.write_all(head).await.is_err() {
                            return;
                        }
                        if slow {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                        }
                        if stream.write_all(b"ok").await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (base, accepted)
    }

    async fn get(pool: &Pool<Plain>, url: &str) -> String {
        let mut request = Request::new(Full::new(Bytes::new()));
        *request.uri_mut() = url.parse().unwrap();
        let response = pool.send(request).await.unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(body.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn requests_reuse_a_kept_connection() {
        let (base, accepted) = server(usize::MAX).await;
        let pool = Pool::new(Plain);
        for _ in 0..3 {
            assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_connection_the_server_closed_is_not_used_again() {
        let (base, accepted) = server(1).await;
        let pool = Pool::new(Plain);
        for _ in 0..3 {
            assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_busy_connection_is_not_shared() {
        let (base, accepted) = server(usize::MAX).await;
        let pool = Pool::new(Plain);
        let mut request = Request::new(Full::new(Bytes::new()));
        *request.uri_mut() = format!("{base}/slow").parse().unwrap();
        // Its body still to come, the first connection is busy.
        let first = pool.send(request).await.unwrap();
        assert_eq!(get(&pool, &format!("{base}/y")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        let body = first.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, "ok");
        // Both are kept, and ready again.
        assert_eq!(get(&pool, &format!("{base}/z")).await, "ok");
        assert_eq!(get(&pool, &format!("{base}/z")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_unused_for_a_minute_closes_and_not_before() {
        let (base, accepted) = server(usize::MAX).await;
        let pool = Pool::new(Plain);
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        tokio::time::sleep(IDLE - Duration::from_secs(1)).await;
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        // A minute from when its last response ended, even with no request
        // to look at it then.
        tokio::time::sleep(IDLE + Duration::from_secs(1)).await;
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn the_watching_task_stops_once_nothing_is_kept() {
        let (base, _) = server(usize::MAX).await;
        let pool = Pool::new(Plain);
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert!(pool.kept.sweeping.load(Ordering::Acquire));
        tokio::time::sleep(IDLE + Duration::from_secs(1)).await;
        assert!(!pool.kept.sweeping.load(Ordering::Acquire));
        assert!(pool.kept.lock().is_empty());
        // A connection kept later starts it again.
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert!(pool.kept.sweeping.load(Ordering::Acquire));
    }

    /// A server whose `/stream` answer sends its head, then its body
    /// `hold` later, as a long streamed answer does.
    async fn streaming_server(hold: Duration) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&accepted);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    loop {
                        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            let mut chunk = [0; 1024];
                            match stream.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                            }
                        }
                        let streams = buf.starts_with(b"GET /stream ");
                        buf.clear();
                        let head = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n";
                        if stream.write_all(head).await.is_err() {
                            return;
                        }
                        if streams {
                            tokio::time::sleep(hold).await;
                        }
                        if stream.write_all(b"ok").await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (base, accepted)
    }

    #[tokio::test(start_paused = true)]
    async fn a_long_answer_does_not_count_as_time_unused() {
        // Its body ends 111 s after its head, past a sweep; the next request
        // comes 15 s after that and finds the connection kept.
        let (base, accepted) = streaming_server(Duration::from_secs(111)).await;
        let pool = Pool::new(Plain);
        assert_eq!(get(&pool, &format!("{base}/stream")).await, "ok");
        tokio::time::advance(Duration::from_secs(15)).await;
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn host_headers_name_the_port_only_when_it_is_not_the_default() {
        let host = |scheme: Scheme, authority: &str| {
            Origin::new(&scheme, &authority.parse().unwrap()).host
        };
        assert_eq!(host(Scheme::HTTPS, "api.example.com"), "api.example.com");
        assert_eq!(
            host(Scheme::HTTPS, "api.example.com:443"),
            "api.example.com"
        );
        assert_eq!(host(Scheme::HTTP, "127.0.0.1:80"), "127.0.0.1");
        assert_eq!(host(Scheme::HTTP, "127.0.0.1:9250"), "127.0.0.1:9250");
        assert_eq!(host(Scheme::HTTPS, "[::1]:8443"), "[::1]:8443");
    }
}
