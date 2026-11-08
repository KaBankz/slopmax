//! One body for every answer streamed back to an agent.
//!
//! [`Relay`] passes the upstream's bytes through untouched, shows them to a
//! [`Tap`] for usage and in-stream refusals, fails a stream that stalls, and
//! records the request exactly once, however it ends: completed, broken off
//! upstream, stalled, abandoned by the agent, or cut short by a stop. The
//! record is made in [`Settle`], which [`Relay`] calls at the end or when it
//! is dropped, so there is no path that records twice or not at all.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, StatusCode};
use hyper::body::{Body, Frame, SizeHint};
use tokio::time::{Instant, Sleep};

use super::App;
use crate::ledger::{End, Entry};
use crate::net::body::BoxError;
use crate::pool::DEFAULT_BLOCK;
use crate::provider::ProviderId;
use crate::time::Timestamp;
use crate::wire::sse::{Shape, Tap};
use crate::wire::{Dialect, Outcome};

/// How long a stream may send nothing before it counts as stalled. Models
/// think quietly for minutes; providers send pings well within this.
pub(crate) const STALL: Duration = Duration::from_secs(600);

/// An answer being served, for the usage ledger.
pub(crate) struct Served {
    pub id: String,
    pub provider: ProviderId,
    pub model: Option<String>,
    pub status: StatusCode,
    pub started: Instant,
    pub attempts: u32,
    pub agent: Option<&'static str>,
    pub session: Option<String>,
}

/// Records one served request: in the pool (usage, and a block when the
/// quota ran out inside the answer) and in the ledger.
pub(crate) struct Settle {
    app: Arc<App>,
    served: Served,
}

impl Settle {
    pub fn new(app: Arc<App>, served: Served) -> Self {
        Self { app, served }
    }

    /// Records the request as the agent got it: `status`, and how its
    /// stream ended.
    pub fn record(
        self,
        outcome: Outcome,
        first_byte: Option<Instant>,
        end: End,
        status: StatusCode,
    ) {
        let Self { app, served } = self;
        app.pool.add_usage(&served.id, &outcome.usage);
        if outcome.exhausted {
            let until = Timestamp::now() + DEFAULT_BLOCK;
            app.pool
                .block(&served.id, until, None, "usage limit reached mid-stream");
        }
        let millis = |at: Instant| at.duration_since(served.started).as_millis() as u64;
        let usage = outcome.usage;
        let entry = Entry {
            at: Timestamp::now(),
            account: served.id,
            provider: served.provider,
            model: served.model,
            status: status.as_u16(),
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_read: usage.cache_read_tokens,
            cache_write: usage.cache_write_tokens,
            ms: millis(Instant::now()),
            first_byte_ms: first_byte.map(millis),
            attempts: served.attempts,
            agent: served.agent.map(str::to_owned),
            session: served.session,
            end: (end != End::Complete).then_some(end),
        };
        app.record(&entry);
    }

    pub fn status(&self) -> StatusCode {
        self.served.status
    }

    pub fn provider(&self) -> ProviderId {
        self.served.provider
    }

    pub fn account(&self) -> &str {
        &self.served.id
    }
}

/// How a response body is read, by its headers: compressed bodies pass
/// through unread, JSON bodies are read whole, anything else as events.
pub(crate) fn shape(headers: &HeaderMap) -> Shape {
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    if header("content-encoding").is_some_and(|v| v != "identity") {
        Shape::Opaque
    } else if header("content-type").is_some_and(|v| v.contains("json")) {
        Shape::Json
    } else {
        Shape::Events
    }
}

/// The upstream's answer on its way to the agent.
pub(crate) struct Relay<B> {
    inner: B,
    /// The start of the stream, held back while it opened, sent first.
    held: VecDeque<Bytes>,
    tap: Tap,
    /// When the upstream last sent something.
    last: Instant,
    /// Fires at the stall deadline; armed only while the upstream is quiet,
    /// and pushed back only when it fires early, never per chunk.
    stall: Option<Pin<Box<Sleep>>>,
    idle: Duration,
    first_byte: Option<Instant>,
    settle: Option<Settle>,
    /// An error that broke the stream off while its start was held, sent
    /// once the held start has gone out.
    broke: Option<BoxError>,
}

#[derive(Debug)]
pub(crate) struct Stalled(Duration);

impl std::fmt::Display for Stalled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the upstream sent nothing for {:?}", self.0)
    }
}

impl std::error::Error for Stalled {}

impl<B> Relay<B> {
    pub fn new(
        inner: B,
        held: Vec<Bytes>,
        wire: Dialect,
        shape: Shape,
        settle: Settle,
        idle: Duration,
    ) -> Self {
        let mut tap = Tap::new(wire, shape);
        for chunk in &held {
            tap.feed(chunk);
        }
        Self {
            inner,
            held: held.into(),
            tap,
            last: Instant::now(),
            stall: None,
            idle,
            first_byte: None,
            settle: Some(settle),
            broke: None,
        }
    }

    /// Ends the stream with `error` after the held start.
    pub fn broken(mut self, error: BoxError) -> Self {
        self.broke = Some(error);
        self
    }

    fn end(&mut self, end: End) {
        if let Some(settle) = self.settle.take() {
            let status = settle.status();
            settle.record(self.tap.finish(), self.first_byte, end, status);
        }
    }

    fn sent(&mut self, now: Instant) {
        self.first_byte.get_or_insert(now);
    }
}

impl<B> Body for Relay<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        if let Some(chunk) = this.held.pop_front() {
            this.sent(Instant::now());
            return Poll::Ready(Some(Ok(Frame::data(chunk))));
        }
        if let Some(error) = this.broke.take() {
            this.end(End::UpstreamError);
            return Poll::Ready(Some(Err(error)));
        }
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                let now = Instant::now();
                this.last = now;
                if let Some(chunk) = frame.data_ref() {
                    this.tap.feed(chunk);
                    this.sent(now);
                }
                return Poll::Ready(Some(Ok(frame)));
            }
            Poll::Ready(Some(Err(e))) => {
                this.end(End::UpstreamError);
                return Poll::Ready(Some(Err(e.into())));
            }
            Poll::Ready(None) => {
                this.end(End::Complete);
                return Poll::Ready(None);
            }
            Poll::Pending => {}
        }
        let (last, idle) = (this.last, this.idle);
        let stall = this
            .stall
            .get_or_insert_with(|| Box::pin(tokio::time::sleep_until(last + idle)));
        loop {
            ready!(stall.as_mut().poll(cx));
            let due = last + idle;
            if Instant::now() >= due {
                break;
            }
            stall.as_mut().reset(due);
        }
        this.end(End::Stalled);
        Poll::Ready(Some(Err(Stalled(idle).into())))
    }

    fn is_end_stream(&self) -> bool {
        self.held.is_empty() && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        let held: usize = self.held.iter().map(Bytes::len).sum();
        let inner = self.inner.size_hint();
        let mut hint = SizeHint::new();
        hint.set_lower(inner.lower() + held as u64);
        if let Some(upper) = inner.upper() {
            hint.set_upper(upper + held as u64);
        }
        hint
    }
}

impl<B> Drop for Relay<B> {
    fn drop(&mut self) {
        // Dropped before its end: the agent hung up, or the daemon stopped
        // and cut the stream.
        let stopping = self
            .settle
            .as_ref()
            .is_some_and(|s| s.app.stop.is_cancelled());
        self.end(if stopping { End::Cut } else { End::ClientGone });
    }
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;
    use tokio::sync::mpsc;

    use super::*;
    use crate::config::Config;
    use crate::ledger;
    use crate::net::Origins;
    use crate::paths::Home;
    use crate::pool::State as PoolState;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slopmax-{name}-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An upstream body the test feeds chunk by chunk.
    struct Fed(mpsc::UnboundedReceiver<Result<Bytes, BoxError>>);

    impl Body for Fed {
        type Data = Bytes;
        type Error = BoxError;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            self.0
                .poll_recv(cx)
                .map(|next| next.map(|chunk| chunk.map(Frame::data)))
        }
    }

    const START: &str = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n";

    fn relay(
        held: &[&'static str],
    ) -> (
        Arc<App>,
        mpsc::UnboundedSender<Result<Bytes, BoxError>>,
        Relay<Fed>,
    ) {
        let dir = temp_dir("relay");
        let app = App::new(
            Config::default(),
            Home::at(&dir),
            PoolState::default(),
            Origins::new([]),
        );
        let (feed, fed) = mpsc::unbounded_channel();
        let served = Served {
            id: "acct".into(),
            provider: ProviderId::Claude,
            model: Some("claude-opus-5-5".into()),
            status: StatusCode::OK,
            started: Instant::now(),
            attempts: 1,
            agent: Some("claude"),
            session: None,
        };
        let held = held
            .iter()
            .map(|h| Bytes::from_static(h.as_bytes()))
            .collect();
        let settle = Settle::new(app.clone(), served);
        let relay = Relay::new(
            Fed(fed),
            held,
            Dialect::Messages,
            Shape::Events,
            settle,
            Duration::from_secs(10),
        );
        (app, feed, relay)
    }

    fn recorded(app: &App) -> Vec<Entry> {
        let entries = ledger::read(&app.home.usage(), Timestamp::UNIX_EPOCH);
        let _ = std::fs::remove_dir_all(app.home.dir());
        entries
    }

    #[tokio::test]
    async fn a_whole_answer_is_recorded_once_with_its_usage() {
        let (app, feed, mut relay) = relay(&[START]);
        feed.send(Ok(Bytes::from_static(
            b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
        )))
        .unwrap();
        drop(feed);
        let mut text = Vec::new();
        while let Some(frame) = relay.frame().await {
            text.extend_from_slice(&frame.unwrap().into_data().unwrap());
        }
        assert!(text.starts_with(START.as_bytes()));
        drop(relay);
        let entries = recorded(&app);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(
            (entry.status, entry.input, entry.output, entry.end),
            (200, 10, 7, None)
        );
        assert!(entry.first_byte_ms.is_some() && !entry.failed());
    }

    #[tokio::test]
    async fn an_agent_that_hangs_up_is_recorded_once_and_not_as_a_failure() {
        let (app, _feed, mut relay) = relay(&[]);
        _feed
            .send(Ok(Bytes::from_static(START.as_bytes())))
            .unwrap();
        relay.frame().await.unwrap().unwrap();
        drop(relay);
        let entries = recorded(&app);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            (entries[0].status, entries[0].input, entries[0].end),
            (200, 10, Some(End::ClientGone))
        );
        assert!(!entries[0].failed());
    }

    #[tokio::test]
    async fn an_upstream_that_breaks_off_is_a_failure() {
        let (app, feed, mut relay) = relay(&[START]);
        relay.frame().await.unwrap().unwrap();
        feed.send(Err("connection reset".into())).unwrap();
        assert!(relay.frame().await.unwrap().is_err());
        drop(relay);
        let entries = recorded(&app);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].end, Some(End::UpstreamError));
        assert!(entries[0].failed());
    }

    #[tokio::test]
    async fn an_error_while_the_start_was_held_follows_the_start() {
        let (app, _feed, relay) = relay(&[START]);
        let mut relay = relay.broken("reset while held".into());
        assert_eq!(
            relay.frame().await.unwrap().unwrap().into_data().unwrap(),
            START
        );
        assert!(relay.frame().await.unwrap().is_err());
        drop(relay);
        assert_eq!(recorded(&app)[0].end, Some(End::UpstreamError));
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_upstream_stalls_once_it_has_been_quiet_long_enough() {
        let (app, feed, mut relay) = relay(&[]);
        // Chunks keep it alive past the limit as a whole…
        for _ in 0..3 {
            feed.send(Ok(Bytes::from_static(b": ping\n\n"))).unwrap();
            relay.frame().await.unwrap().unwrap();
            tokio::time::advance(Duration::from_secs(6)).await;
        }
        // …then silence for longer than it ends it.
        let started = Instant::now();
        let error = relay.frame().await.unwrap().unwrap_err();
        assert!(error.is::<Stalled>(), "{error}");
        assert!(Instant::now() - started >= Duration::from_secs(4));
        drop(relay);
        let entries = recorded(&app);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].end, Some(End::Stalled));
        drop(feed);
    }
}
