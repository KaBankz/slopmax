//! Re-encoding an upstream answer for a client that speaks another format,
//! as it streams.
//!
//! Lines of the upstream's event stream are read as answer events, which
//! the client's encoder writes out at once. An upstream that answered with
//! one JSON document is read whole at the end. If the upstream breaks off,
//! the client hears a failure in its own format instead of a cut stream.

use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::{Duration, Instant};

use bytes::Bytes;
use hyper::body::{Body as HttpBody, Frame, SizeHint};

use crate::net::body::{Body, BoxError};
use crate::wire::ir::Event;
use crate::wire::translate::{Decoder, Encoder};

/// Longest line or JSON body buffered.
const MAX_BUFFER: usize = 64 * 1024 * 1024;

/// Sees every event before the client does.
pub type Watch = Box<dyn FnMut(&Event) + Send>;

pub struct Transcode {
    inner: Body,
    /// The upstream answered with one JSON document rather than events.
    json: bool,
    buffer: Vec<u8>,
    decoder: Decoder,
    encoder: Encoder,
    watch: Watch,
    ended: bool,
}

impl Transcode {
    pub fn new(inner: Body, json: bool, decoder: Decoder, encoder: Encoder, watch: Watch) -> Self {
        Self {
            inner,
            json,
            buffer: Vec::new(),
            decoder,
            encoder,
            watch,
            ended: false,
        }
    }

    fn write(&mut self, events: Vec<Event>) -> Vec<u8> {
        let mut out = Vec::new();
        for event in &events {
            (self.watch)(event);
            self.encoder.event(event, &mut out);
        }
        out
    }

    fn feed(&mut self, mut chunk: &[u8]) -> Vec<u8> {
        if self.buffer.len() + chunk.len() > MAX_BUFFER {
            // Too much to hold: let the end of the stream report it.
            return Vec::new();
        }
        if self.json {
            self.buffer.extend_from_slice(chunk);
            return Vec::new();
        }
        let mut events = Vec::new();
        while let Some(newline) = chunk.iter().position(|b| *b == b'\n') {
            self.buffer.extend_from_slice(&chunk[..newline]);
            let line = std::mem::take(&mut self.buffer);
            self.line(&line, &mut events);
            chunk = &chunk[newline + 1..];
        }
        self.buffer.extend_from_slice(chunk);
        self.write(events)
    }

    fn line(&mut self, line: &[u8], events: &mut Vec<Event>) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(data) = line.strip_prefix(b"data:") {
            self.decoder.data(data, events);
        }
    }

    fn end(&mut self) -> Vec<u8> {
        let mut events = Vec::new();
        let rest = std::mem::take(&mut self.buffer);
        if self.json {
            self.decoder.whole(&rest, &mut events);
        } else {
            self.line(&rest, &mut events);
            self.decoder.finish(&mut events);
        }
        self.write(events)
    }
}

impl HttpBody for Transcode {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        loop {
            if self.ended {
                return Poll::Ready(None);
            }
            let out = match ready!(Pin::new(&mut self.inner).poll_frame(cx)) {
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(chunk) => self.feed(&chunk),
                    Err(_) => continue,
                },
                // A broken upstream ends the answer like a cut stream.
                Some(Err(_)) | None => {
                    self.ended = true;
                    self.end()
                }
            };
            if !out.is_empty() {
                return Poll::Ready(Some(Ok(Frame::data(out.into()))));
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.ended
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

/// Every event of a whole upstream body, each shown to `watch` first.
pub fn events(mut decoder: Decoder, json: bool, body: &[u8], mut watch: Watch) -> Vec<Event> {
    let mut events = Vec::new();
    if json {
        decoder.whole(body, &mut events);
    } else {
        for line in body.split(|b| *b == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if let Some(data) = line.strip_prefix(b"data:") {
                decoder.data(data, &mut events);
            }
        }
        decoder.finish(&mut events);
    }
    for event in &events {
        watch(event);
    }
    events
}

/// Reasoning state upstreams issued alongside tool calls, kept for the
/// next turn when the client's format cannot carry it back. Keyed by the
/// call it preceded, and only replayed to the account that issued it.
#[derive(Debug, Default)]
pub struct Replay {
    entries: HashMap<String, (String, String, Instant)>,
    order: VecDeque<String>,
}

impl Replay {
    /// Entries kept at most; the oldest go first.
    const MAX: usize = 4096;
    /// How long state stays useful: a turn's tool loop, with room to spare.
    const TTL: Duration = Duration::from_secs(2 * 3600);

    pub fn remember(&mut self, call: &str, account: &str, state: String) {
        if self.entries.len() >= Self::MAX
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        let entry = (account.to_owned(), state, Instant::now());
        if self.entries.insert(call.to_owned(), entry).is_none() {
            self.order.push_back(call.to_owned());
        }
    }

    pub fn recall(&self, call: &str, account: &str) -> Option<String> {
        let (owner, state, at) = self.entries.get(call)?;
        (owner == account && at.elapsed() < Self::TTL).then(|| state.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::body;
    use crate::wire::Dialect;
    use crate::wire::ir::Request;
    use http_body_util::BodyExt;
    use std::sync::{Arc, Mutex};

    /// A body yielding fixed chunks.
    struct Chunks(VecDeque<Bytes>);

    impl HttpBody for Chunks {
        type Data = Bytes;
        type Error = BoxError;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            Poll::Ready(self.0.pop_front().map(|chunk| Ok(Frame::data(chunk))))
        }
    }

    fn chunked(chunks: &[&'static str]) -> Body {
        body::boxed(Chunks(
            chunks
                .iter()
                .map(|c| Bytes::from_static(c.as_bytes()))
                .collect(),
        ))
    }

    #[tokio::test]
    async fn chat_chunks_split_anywhere_become_messages_events() {
        let upstream = chunked(&[
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel",
            "lo\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n",
            "\ndata: [DONE]\n\n",
        ]);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let watch: Watch = {
            let seen = seen.clone();
            Box::new(move |e: &Event| seen.lock().unwrap().push(e.clone()))
        };
        let request = Request::default();
        let transcode = Transcode::new(
            upstream,
            false,
            Decoder::new(Dialect::Chat, &request),
            Encoder::new(Dialect::Messages, "grok-4", false),
            watch,
        );
        let out = transcode.collect().await.unwrap().to_bytes();
        let text = String::from_utf8(out.to_vec()).unwrap();
        assert!(text.contains(r#""text":"Hello""#), "{text}");
        assert!(text.contains("message_stop"), "{text}");
        assert_eq!(seen.lock().unwrap()[0], Event::Text("Hello".into()));
    }

    #[test]
    fn replay_is_per_account_and_bounded() {
        let mut replay = Replay::default();
        replay.remember("call_1", "codex-a", "gAAA".into());
        assert_eq!(replay.recall("call_1", "codex-a").as_deref(), Some("gAAA"));
        assert_eq!(replay.recall("call_1", "codex-b"), None);
        for i in 0..Replay::MAX + 10 {
            replay.remember(&format!("c{i}"), "codex-a", String::new());
        }
        assert!(replay.entries.len() <= Replay::MAX);
        assert_eq!(
            replay.recall("call_1", "codex-a"),
            None,
            "the oldest went first"
        );
    }
}
