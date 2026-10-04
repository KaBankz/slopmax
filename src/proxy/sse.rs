//! Watches streamed responses without altering them.
//!
//! Bytes pass straight through to the agent while a line parser hands each
//! event to the dialect, which picks out token usage and refusals that
//! arrive inside a 200 stream.

use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Instant;

use bytes::Bytes;
use http::HeaderMap;
use hyper::body::{Body, Frame, SizeHint};
use serde_json::Value;

use crate::wire::{Dialect, Outcome};

/// Longest line the tap will buffer; longer lines pass through unparsed.
const MAX_LINE: usize = 16 * 1024 * 1024;

/// How a response body is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// Server-sent events, read line by line.
    Events,
    /// One JSON document, read whole at the end.
    Json,
    /// Compressed: passed through unread; only the request counts.
    Opaque,
}

#[derive(Debug)]
pub struct Tap {
    dialect: Dialect,
    shape: Shape,
    line: Vec<u8>,
    overflow: bool,
    outcome: Outcome,
}

impl Tap {
    /// A tap for an event stream.
    pub fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            shape: Shape::Events,
            line: Vec::new(),
            overflow: false,
            outcome: Outcome::default(),
        }
    }

    /// A tap shaped by the response headers: compressed bodies pass through
    /// unread, JSON bodies are read whole, anything else as events.
    pub fn for_response(dialect: Dialect, headers: &HeaderMap) -> Self {
        let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
        let shape = if header("content-encoding").is_some_and(|v| v != "identity") {
            Shape::Opaque
        } else if header("content-type").is_some_and(|v| v.contains("json")) {
            Shape::Json
        } else {
            Shape::Events
        };
        Self {
            shape,
            ..Self::new(dialect)
        }
    }

    pub fn feed(&mut self, mut chunk: &[u8]) {
        match self.shape {
            Shape::Opaque => return,
            Shape::Json => {
                if self.line.len() + chunk.len() > MAX_LINE {
                    self.overflow = true;
                } else if !self.overflow {
                    self.line.extend_from_slice(chunk);
                }
                return;
            }
            Shape::Events => {}
        }
        while let Some(newline) = memchr::memchr(b'\n', chunk) {
            if !self.overflow {
                if self.line.is_empty() {
                    // The whole line is in this chunk: read it in place.
                    self.line(&chunk[..newline]);
                } else {
                    self.line.extend_from_slice(&chunk[..newline]);
                    let line = std::mem::take(&mut self.line);
                    self.line(&line);
                    // Keep the buffer for the next split line.
                    self.line = line;
                    self.line.clear();
                }
            }
            self.overflow = false;
            chunk = &chunk[newline + 1..];
        }
        if self.line.len() + chunk.len() > MAX_LINE {
            self.overflow = true;
            self.line.clear();
        } else if !self.overflow {
            self.line.extend_from_slice(chunk);
        }
    }

    pub fn finish(mut self) -> Outcome {
        let line = std::mem::take(&mut self.line);
        match self.shape {
            Shape::Events => self.line(&line),
            Shape::Json if !self.overflow => {
                if let Ok(body) = serde_json::from_slice::<Value>(&line) {
                    self.dialect.observe(&body, &mut self.outcome);
                }
            }
            Shape::Json | Shape::Opaque => {}
        }
        self.outcome.usage.requests = 1;
        self.outcome
    }

    fn line(&mut self, line: &[u8]) {
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let interesting = [&b"usage"[..], b"error", b"failed"]
            .iter()
            .any(|needle| memchr::memmem::find(data, needle).is_some());
        if !interesting {
            return;
        }
        let Ok(event) = serde_json::from_slice::<Value>(data.trim_ascii()) else {
            return;
        };
        self.dialect.observe(&event, &mut self.outcome);
    }
}

type Done = Box<dyn FnOnce(Outcome, Option<Instant>) + Send>;

/// A response body that reports its [`Outcome`] once, when it ends or is
/// dropped early (the agent disconnected), with when its first byte went
/// out.
pub struct Tapped<B> {
    inner: B,
    tap: Option<Tap>,
    first_byte: Option<Instant>,
    done: Option<Done>,
}

impl<B> Tapped<B> {
    pub fn new(
        inner: B,
        tap: Tap,
        done: impl FnOnce(Outcome, Option<Instant>) + Send + 'static,
    ) -> Self {
        Self {
            inner,
            tap: Some(tap),
            first_byte: None,
            done: Some(Box::new(done)),
        }
    }

    fn report(&mut self) {
        if let (Some(tap), Some(done)) = (self.tap.take(), self.done.take()) {
            done(tap.finish(), self.first_byte);
        }
    }
}

impl<B> Body for Tapped<B>
where
    B: Body<Data = Bytes> + Unpin,
{
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        let frame = ready!(Pin::new(&mut self.inner).poll_frame(cx));
        match &frame {
            Some(Ok(frame)) => {
                if let Some(chunk) = frame.data_ref() {
                    self.first_byte.get_or_insert_with(Instant::now);
                    if let Some(tap) = self.tap.as_mut() {
                        tap.feed(chunk);
                    }
                }
            }
            Some(Err(_)) | None => self.report(),
        }
        Poll::Ready(frame)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl<B> Drop for Tapped<B> {
    fn drop(&mut self) {
        self.report();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::body::BoxError;
    use crate::pool::Usage;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// A body yielding fixed chunks.
    struct Chunks(VecDeque<Bytes>);

    impl Body for Chunks {
        type Data = Bytes;
        type Error = BoxError;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            Poll::Ready(self.0.pop_front().map(|chunk| Ok(Frame::data(chunk))))
        }
    }

    #[test]
    fn claude_usage_merges_start_and_delta() {
        let mut tap = Tap::new(Dialect::Messages);
        let stream = concat!(
            "event: message_start\n",
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}"#,
            "\n\nevent: content_block_delta\n",
            r#"data: {"type":"content_block_delta","delta":{"text":"hi"}}"#,
            "\n\nevent: message_delta\n",
            r#"data: {"type":"message_delta","usage":{"output_tokens":15}}"#,
            "\n\n"
        );
        // Split mid-line to exercise buffering.
        let (a, b) = stream.split_at(70);
        tap.feed(a.as_bytes());
        tap.feed(b.as_bytes());
        let outcome = tap.finish();
        assert_eq!(
            outcome.usage,
            Usage {
                requests: 1,
                input_tokens: 2095,
                output_tokens: 15,
                cache_read_tokens: 355_598,
                cache_write_tokens: 7185,
            }
        );
        assert!(!outcome.exhausted);
    }

    #[test]
    fn codex_usage_separates_cached_input() {
        let mut tap = Tap::new(Dialect::Responses);
        tap.feed(br#"data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":25},"output_tokens":40,"total_tokens":140}}}"#);
        tap.feed(b"\n\n");
        let usage = tap.finish().usage;
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens
            ),
            (75, 25, 40)
        );
    }

    #[test]
    fn whole_json_responses_report_usage() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        let mut tap = Tap::for_response(Dialect::Messages, &headers);
        tap.feed(br#"{"type":"message","content":[],"usage":{"input_tokens":12,"#);
        tap.feed(br#""output_tokens":3,"cache_read_input_tokens":40}}"#);
        let usage = tap.finish().usage;
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens
            ),
            (12, 3, 40)
        );

        let mut tap = Tap::for_response(Dialect::Responses, &headers);
        tap.feed(br#"{"object":"response","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":20},"output_tokens":5}}"#);
        let usage = tap.finish().usage;
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens
            ),
            (30, 20, 5)
        );

        headers.insert("content-encoding", "gzip".parse().unwrap());
        let mut tap = Tap::for_response(Dialect::Messages, &headers);
        tap.feed(b"\x1f\x8b");
        assert_eq!(tap.finish().usage.requests, 1);
    }

    #[test]
    fn codex_in_stream_usage_limit_is_exhaustion() {
        let mut tap = Tap::new(Dialect::Responses);
        tap.feed(b"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\n");
        assert!(tap.finish().exhausted);
    }

    #[tokio::test]
    async fn tapped_stream_reports_once_even_when_dropped() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let chunks = Chunks(VecDeque::from([
            Bytes::from_static(
                b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n",
            ),
            Bytes::from_static(b"data: tail\n"),
        ]));
        let log = seen.clone();
        let mut body = Tapped::new(chunks, Tap::new(Dialect::Messages), move |o, first| {
            assert!(first.is_some(), "a chunk went out");
            log.lock().unwrap().push(o)
        });
        let first = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
        assert!(first.is_some());
        drop(body);
        let reports = seen.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].usage.output_tokens, 3);
    }
}
