//! Keep-alive HTTP/1.1 connections, kept per origin for the next request.
//!
//! A connection goes back on its origin's list as soon as its response
//! starts, and a request takes it again only once it is ready, its last
//! response read to the end. Asking that when a request needs one, rather
//! than waiting on it in a task, keeps a request on a kept connection free
//! of tasks and channels of its own. One task per pool, alive while any
//! connection is kept, watches them: it wakes as a response ends, to start
//! that connection's idle clock then, and when one has been unused for a
//! minute, to close it, as hyper-util's pool did. A request that finds
//! none ready while some are busy dials a new one but takes the first
//! of those to come free, if that comes sooner.

use std::collections::VecDeque;
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
use tokio::sync::oneshot;
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
    /// Requests that found every connection busy, first come first, each
    /// to be handed the first that comes free unless its own new one is
    /// ready sooner.
    waiting: VecDeque<oneshot::Sender<Sender>>,
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
        let mut found = self
            .kept
            .checkout(&scheme, &authority, Instant::now(), true);
        request.headers_mut().entry(HOST).or_insert(found.host);
        // A new connection closed before the request went out is tried
        // once more; a kept one, as long as kept ones are left.
        let mut fresh_retried = false;
        loop {
            let (mut sender, reused) = match (found.ready.take(), found.waiter.take()) {
                (Some(sender), _) => (sender, true),
                (None, Some(waiter)) => self.connect_or_take(&scheme, &authority, waiter).await?,
                (None, None) => (self.connect(&scheme, &authority).await?, false),
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
                    // A connection the server closed before the request
                    // went out: it goes out on another.
                    Some(unsent) if reused || !fresh_retried => {
                        fresh_retried |= !reused;
                        request = unsent;
                        found = self
                            .kept
                            .checkout(&scheme, &authority, Instant::now(), false);
                    }
                    taken => {
                        let sent = taken.is_none();
                        self.kept.forget_if_unused(&scheme, &authority);
                        return Err(failure(&failed.into_error(), &authority, sent).into());
                    }
                },
            }
        }
    }

    /// A new connection, or a kept one that comes free while it is being
    /// made, whichever is first; and whether it is a kept one.
    async fn connect_or_take(
        &self,
        scheme: &Scheme,
        authority: &Authority,
        mut waiter: oneshot::Receiver<Sender>,
    ) -> Result<(Sender, bool), BoxError> {
        let connecting = self.connect(scheme, authority);
        tokio::select! {
            biased;
            Ok(sender) = &mut waiter => Ok((sender, true)),
            made = connecting => {
                waiter.close();
                // One handed over just as the new one was made is kept for
                // the next request.
                if let Ok(spare) = waiter.try_recv() {
                    self.kept.checkin(scheme, authority, spare);
                }
                made.map(|sender| (sender, false))
            }
        }
    }

    /// A new connection to the origin, ready for a request.
    async fn connect(&self, scheme: &Scheme, authority: &Authority) -> Result<Sender, BoxError> {
        let made = async {
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
            Ok::<_, BoxError>(sender)
        };
        made.await.map_err(|error| {
            self.kept.forget_if_unused(scheme, authority);
            format!("connecting to {authority}: {}", root(&*error)).into()
        })
    }
}

/// What a request on a connection that failed says: the server, and what
/// happened, in place of hyper's own wording.
fn failure(error: &hyper::Error, authority: &Authority, sent: bool) -> String {
    let host = authority.host();
    if let Some(io) = root_io(error) {
        return format!("{host}: {io}");
    }
    if error.is_incomplete_message() || error.is_closed() || error.is_canceled() {
        return if sent {
            format!("{host} closed the connection before it answered")
        } else {
            format!("{host} closed the connection before the request went out")
        };
    }
    if error.is_parse() {
        return format!("{host} answered with something that is not HTTP: {error}");
    }
    format!("{host}: {error}")
}

/// The deepest cause of `error`, which says what happened: a refused
/// connection, a TLS alert.
fn root<'a>(error: &'a (dyn std::error::Error + 'static)) -> &'a (dyn std::error::Error + 'static) {
    let mut root = error;
    while let Some(cause) = root.source() {
        root = cause;
    }
    root
}

/// The I/O error under `error`, if one caused it: a reset, a broken pipe.
fn root_io(error: &hyper::Error) -> Option<&std::io::Error> {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(e) = cause {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            return Some(io);
        }
        cause = e.source();
    }
    None
}

/// What a request finds kept for its origin.
struct Found {
    ready: Option<Sender>,
    waiter: Option<oneshot::Receiver<Sender>>,
    /// The `Host` header for the origin.
    host: HeaderValue,
}

impl Kept {
    fn lock(&self) -> MutexGuard<'_, Origins> {
        self.origins.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A kept connection to the origin that is ready for a request, if
    /// there is one; else, if some are busy and `wait`, a place in line
    /// for the first to come free.
    fn checkout(&self, scheme: &Scheme, authority: &Authority, now: Instant, wait: bool) -> Found {
        let mut origins = self.lock();
        let Some(origin) = origins.iter_mut().find(|o| o.is(scheme, authority)) else {
            // Nothing kept there: no entry is made until one is.
            return Found {
                ready: None,
                waiter: None,
                host: Origin::new(scheme, authority).host,
            };
        };
        origin.prune(now);
        // The one used last is the likeliest to be open still.
        let ready = origin.conns.iter().rposition(|c| c.sender.is_ready());
        let ready = ready.map(|at| origin.conns.remove(at).sender);
        let waiter = (ready.is_none() && wait && !origin.conns.is_empty()).then(|| {
            let (tx, rx) = oneshot::channel();
            origin.waiting.push_back(tx);
            rx
        });
        Found {
            ready,
            waiter,
            host: origin.host.clone(),
        }
    }

    /// Drops the origin's entry once nothing is kept there, as when a
    /// request to it failed with none kept.
    fn forget_if_unused(&self, scheme: &Scheme, authority: &Authority) {
        let mut origins = self.lock();
        origins.retain(|o| !o.is(scheme, authority) || !o.conns.is_empty());
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
            waiting: VecDeque::new(),
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
        let mut at = 0;
        while at < self.conns.len() {
            let conn = &mut self.conns[at];
            match conn.sender.poll_ready(cx) {
                Poll::Ready(Ok(())) => {
                    if conn.since.is_none() && self.hand_over(at) {
                        continue;
                    }
                    let conn = &mut self.conns[at];
                    let since = *conn.since.get_or_insert(now);
                    let due = since + IDLE;
                    if due <= now {
                        self.conns.remove(at);
                        continue;
                    }
                    *next = Some(next.map_or(due, |n| n.min(due)));
                }
                Poll::Ready(Err(_)) => {
                    self.conns.remove(at);
                    continue;
                }
                Poll::Pending => conn.since = None,
            }
            at += 1;
        }
        if self.conns.is_empty() {
            // Nothing left to come free: those waiting go on with their own.
            self.waiting.clear();
        }
    }

    /// Hands the connection at `at`, just come free, to the first request
    /// still waiting for one; whether one took it.
    fn hand_over(&mut self, at: usize) -> bool {
        self.waiting.retain(|w| !w.is_closed());
        if self.waiting.is_empty() {
            return false;
        }
        let mut sender = self.conns.remove(at).sender;
        while let Some(waiter) = self.waiting.pop_front() {
            match waiter.send(sender) {
                Ok(()) => return true,
                Err(back) => sender = back,
            }
        }
        self.conns.insert(
            at,
            Conn {
                sender,
                since: None,
            },
        );
        false
    }

    /// Drops the connections that closed and those unused too long. One
    /// still busy with its last response is not unused.
    fn prune(&mut self, now: Instant) {
        self.waiting.retain(|w| !w.is_closed());
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

    /// Plain TCP to the address in the URI, made `delay` late.
    #[derive(Clone, Default)]
    struct Plain {
        delay: Duration,
    }

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
            let delay = self.delay;
            Box::pin(async move {
                tokio::time::sleep(delay).await;
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
        let pool = Pool::new(Plain::default());
        for _ in 0..3 {
            assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_connection_the_server_closed_is_not_used_again() {
        let (base, accepted) = server(1).await;
        let pool = Pool::new(Plain::default());
        for _ in 0..3 {
            assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_busy_connection_is_not_shared() {
        let (base, accepted) = server(usize::MAX).await;
        let pool = Pool::new(Plain::default());
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
        let pool = Pool::new(Plain::default());
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
        let pool = Pool::new(Plain::default());
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
        let pool = Pool::new(Plain::default());
        assert_eq!(get(&pool, &format!("{base}/stream")).await, "ok");
        tokio::time::advance(Duration::from_secs(15)).await;
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_request_takes_a_connection_that_comes_free_before_its_own_is_made() {
        let (base, accepted) = server(usize::MAX).await;
        let pool = Pool::new(Plain {
            delay: Duration::from_millis(600),
        });
        let mut request = Request::new(Full::new(Bytes::new()));
        *request.uri_mut() = format!("{base}/slow").parse().unwrap();
        let first = pool.send(request).await.unwrap();
        let reading = tokio::spawn(first.into_body().collect());
        // The first connection comes free 300 ms on, before a new one
        // would be made at 600.
        let started = Instant::now();
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert!(started.elapsed() < Duration::from_millis(550));
        assert_eq!(reading.await.unwrap().unwrap().to_bytes(), "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        assert!(pool.kept.lock()[0].waiting.is_empty());
    }

    #[tokio::test]
    async fn a_new_connection_made_first_is_used_and_the_other_kept() {
        let (base, accepted) = server(usize::MAX).await;
        let pool = Pool::new(Plain::default());
        let mut request = Request::new(Full::new(Bytes::new()));
        *request.uri_mut() = format!("{base}/slow").parse().unwrap();
        let first = pool.send(request).await.unwrap();
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        // The one it gave up waiting for is no one's: it stays kept.
        assert_eq!(first.into_body().collect().await.unwrap().to_bytes(), "ok");
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(get(&pool, &format!("{base}/x")).await, "ok");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    /// The error a request to `url` fails with.
    async fn failing(pool: &Pool<Plain>, url: &str) -> String {
        let mut request = Request::new(Full::new(Bytes::new()));
        *request.uri_mut() = url.parse().unwrap();
        match pool.send(request).await {
            Ok(_) => panic!("{url} answered"),
            Err(e) => e.to_string(),
        }
    }

    #[tokio::test]
    async fn failures_name_the_server_and_what_happened() {
        // Reads the request, then hangs up without a word.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut chunk = [0; 1024];
                let _ = stream.read(&mut chunk).await;
            }
        });
        let pool = Pool::new(Plain::default());
        assert_eq!(
            failing(&pool, &format!("http://{addr}/x")).await,
            "127.0.0.1 closed the connection before it answered"
        );
        assert!(pool.kept.lock().is_empty(), "nothing is kept for it");

        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gone = closed.local_addr().unwrap();
        drop(closed);
        let refused = failing(&pool, &format!("http://{gone}/x")).await;
        assert!(
            refused.starts_with(&format!("connecting to {gone}: ")),
            "{refused}"
        );
        assert!(pool.kept.lock().is_empty());
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
