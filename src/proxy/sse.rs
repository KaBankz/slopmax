//! Watches streamed responses without altering them.
//!
//! Bytes pass straight through to the agent while a line parser hands each
//! event to the dialect, which picks out token usage and refusals that
//! arrive inside a 200 stream.

use std::pin::Pin;
use std::task::{Context, Poll, ready};

use bytes::Bytes;
use hyper::body::{Body, Frame, SizeHint};
use serde_json::Value;

use crate::wire::{Dialect, Outcome};

/// Longest line the tap will buffer; longer lines pass through unparsed.
const MAX_LINE: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct Tap {
    dialect: Dialect,
    /// Whether the bytes can be parsed (they are not compressed).
    readable: bool,
    line: Vec<u8>,
    overflow: bool,
    outcome: Outcome,
}

impl Tap {
    pub fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            readable: true,
            line: Vec::new(),
            overflow: false,
            outcome: Outcome::default(),
        }
    }

    /// A tap for a compressed stream: it only counts the request.
    pub fn blind(dialect: Dialect) -> Self {
        Self {
            readable: false,
            ..Self::new(dialect)
        }
    }

    pub fn feed(&mut self, mut chunk: &[u8]) {
        if !self.readable {
            return;
        }
        while let Some(newline) = chunk.iter().position(|b| *b == b'\n') {
            if !self.overflow {
                self.line.extend_from_slice(&chunk[..newline]);
                let line = std::mem::take(&mut self.line);
                self.line(&line);
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
        if self.readable {
            self.line(&line);
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
            .any(|needle| data.windows(needle.len()).any(|w| w == *needle));
        if !interesting {
            return;
        }
        let Ok(event) = serde_json::from_slice::<Value>(data.trim_ascii()) else {
            return;
        };
        self.dialect.observe(&event, &mut self.outcome);
    }
}

type Done = Box<dyn FnOnce(Outcome) + Send>;

/// A response body that reports its [`Outcome`] once, when it ends or is
/// dropped early (the agent disconnected).
pub struct Tapped<B> {
    inner: B,
    tap: Option<Tap>,
    done: Option<Done>,
}

impl<B> Tapped<B> {
    pub fn new(inner: B, tap: Tap, done: impl FnOnce(Outcome) + Send + 'static) -> Self {
        Self {
            inner,
            tap: Some(tap),
            done: Some(Box::new(done)),
        }
    }

    fn report(&mut self) {
        if let (Some(tap), Some(done)) = (self.tap.take(), self.done.take()) {
            done(tap.finish());
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
                if let (Some(chunk), Some(tap)) = (frame.data_ref(), self.tap.as_mut()) {
                    tap.feed(chunk);
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
        let mut body = Tapped::new(chunks, Tap::new(Dialect::Messages), move |o| {
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
