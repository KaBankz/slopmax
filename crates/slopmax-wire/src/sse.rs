//! Server-sent events as they stream past.
//!
//! [`Lines`] splits chunks into lines, borrowing a line that lies within one
//! chunk and buffering only one split across two. [`kind`] reads an event's
//! `type` from its first bytes, so the token deltas that are nearly every
//! event of an answer are passed over without being parsed; only the few
//! events that carry usage or a refusal are. [`Tap`] collects what a
//! finished stream said, and [`Opener`] judges how one opens.

use std::ops::ControlFlow;

use serde_json::Value;

use crate::{Dialect, Opening, Outcome};

/// Longest line buffered; a longer one is passed over unread.
pub const MAX_LINE: usize = 16 * 1024 * 1024;

/// A line splitter for a stream of chunks.
#[derive(Debug, Default)]
pub struct Lines {
    /// The start of a line the last chunk ended inside.
    partial: Vec<u8>,
    /// The current line outgrew [`MAX_LINE`] and is being skipped.
    overflow: bool,
}

impl Lines {
    /// Calls `each` with every line `chunk` completes, without its line
    /// ending, until `each` breaks.
    pub fn feed<T>(
        &mut self,
        mut chunk: &[u8],
        mut each: impl FnMut(&[u8]) -> ControlFlow<T>,
    ) -> ControlFlow<T> {
        while let Some(newline) = memchr::memchr(b'\n', chunk) {
            let overflow = std::mem::take(&mut self.overflow);
            let flow = if overflow {
                self.partial.clear();
                ControlFlow::Continue(())
            } else if self.partial.is_empty() {
                each(trim_cr(&chunk[..newline]))
            } else {
                self.partial.extend_from_slice(&chunk[..newline]);
                let line = std::mem::take(&mut self.partial);
                let flow = each(trim_cr(&line));
                // Keep the allocation for the next split line.
                self.partial = line;
                self.partial.clear();
                flow
            };
            chunk = &chunk[newline + 1..];
            flow?;
        }
        if self.overflow || self.partial.len() + chunk.len() > MAX_LINE {
            self.overflow = true;
            self.partial = Vec::new();
        } else {
            self.partial.extend_from_slice(chunk);
        }
        ControlFlow::Continue(())
    }

    /// The last line, when the stream ended without a line ending.
    pub fn rest(&mut self) -> Option<Vec<u8>> {
        let rest = std::mem::take(&mut self.partial);
        (!rest.is_empty() && !std::mem::take(&mut self.overflow)).then_some(rest)
    }
}

fn trim_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// The JSON of a `data:` line.
pub fn data(line: &[u8]) -> Option<&[u8]> {
    Some(line.strip_prefix(b"data:")?.trim_ascii())
}

/// An event's `type`, when its JSON names it first, as Anthropic and OpenAI
/// both write their stream events.
pub fn kind(data: &[u8]) -> Option<&[u8]> {
    let rest = data.strip_prefix(b"{")?.trim_ascii_start();
    let rest = rest.strip_prefix(b"\"type\"")?.trim_ascii_start();
    let rest = rest.strip_prefix(b":")?.trim_ascii_start();
    let rest = rest.strip_prefix(b"\"")?;
    let end = memchr::memchr2(b'"', b'\\', rest)?;
    (rest[end] == b'"').then(|| &rest[..end])
}

impl Dialect {
    /// Whether an event of `kind` can carry what [`Dialect::observe`] reads:
    /// usage, or a refusal. Deltas cannot.
    pub fn observes(self, kind: &[u8]) -> bool {
        match self {
            Self::Messages => matches!(
                kind,
                b"message_start" | b"message_delta" | b"message" | b"error"
            ),
            Self::Responses => matches!(
                kind,
                b"response.completed"
                    | b"response.incomplete"
                    | b"response.done"
                    | b"response.failed"
                    | b"error"
            ),
            // Chat chunks carry no type.
            Self::Chat => true,
        }
    }
}

/// How a response body is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Server-sent events, read line by line.
    Events,
    /// One JSON document, read whole at the end.
    Json,
    /// Compressed: passed through unread; only the request counts.
    Opaque,
}

/// Watches a response go by and says, at its end, what it reported: token
/// usage, and whether the account's quota ran out inside it.
#[derive(Debug)]
pub struct Tap {
    dialect: Dialect,
    shape: Shape,
    lines: Lines,
    /// A JSON body, collected whole.
    whole: Vec<u8>,
    overflow: bool,
    outcome: Outcome,
}

impl Tap {
    pub fn new(dialect: Dialect, shape: Shape) -> Self {
        Self {
            dialect,
            shape,
            lines: Lines::default(),
            whole: Vec::new(),
            overflow: false,
            outcome: Outcome::default(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        match self.shape {
            Shape::Opaque => {}
            Shape::Json if self.overflow => {}
            Shape::Json if self.whole.len() + chunk.len() > MAX_LINE => {
                self.overflow = true;
                self.whole = Vec::new();
            }
            Shape::Json => self.whole.extend_from_slice(chunk),
            Shape::Events => {
                let (dialect, outcome) = (self.dialect, &mut self.outcome);
                let _: ControlFlow<()> = self.lines.feed(chunk, |line| {
                    event(dialect, line, outcome);
                    ControlFlow::Continue(())
                });
            }
        }
    }

    /// What the response reported; it counts as one request.
    pub fn finish(&mut self) -> Outcome {
        match self.shape {
            Shape::Events => {
                if let Some(line) = self.lines.rest() {
                    event(self.dialect, &line, &mut self.outcome);
                }
            }
            Shape::Json if !self.overflow => {
                if let Ok(body) = serde_json::from_slice::<Value>(&self.whole) {
                    self.dialect.observe(&body, &mut self.outcome);
                }
            }
            Shape::Json | Shape::Opaque => {}
        }
        self.outcome.usage.requests = 1;
        std::mem::take(&mut self.outcome)
    }
}

/// Folds one line into `outcome`, parsing it only when it may matter.
fn event(dialect: Dialect, line: &[u8], outcome: &mut Outcome) {
    let Some(data) = data(line) else { return };
    let worth = match kind(data) {
        Some(kind) => dialect.observes(kind),
        // No type up front: look for what the dialect reads.
        None => [&b"usage"[..], b"error", b"failed"]
            .iter()
            .any(|needle| memchr::memmem::find(data, needle).is_some()),
    };
    if worth && let Ok(event) = serde_json::from_slice::<Value>(data) {
        dialect.observe(&event, outcome);
    }
}

/// Judges how a stream opens, event by event, for [`Dialect::holds_start`].
#[derive(Debug)]
pub struct Opener {
    dialect: Dialect,
    lines: Lines,
}

impl Opener {
    pub fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            lines: Lines::default(),
        }
    }

    /// The first telling event in `chunk`, or [`Opening::Wait`].
    pub fn feed(&mut self, chunk: &[u8]) -> Opening {
        let dialect = self.dialect;
        let flow = self.lines.feed(chunk, |line| match opening(dialect, line) {
            Opening::Wait => ControlFlow::Continue(()),
            told => ControlFlow::Break(told),
        });
        match flow {
            ControlFlow::Break(told) => told,
            ControlFlow::Continue(()) => Opening::Wait,
        }
    }
}

fn opening(dialect: Dialect, line: &[u8]) -> Opening {
    let Some(data) = data(line) else {
        return Opening::Wait;
    };
    match (dialect, kind(data)) {
        (
            Dialect::Responses,
            Some(b"response.created" | b"response.in_progress" | b"response.queued"),
        ) => Opening::Wait,
        (Dialect::Responses, Some(b"response.failed" | b"error")) | (_, None) => {
            match serde_json::from_slice::<Value>(data) {
                Ok(event) => dialect.opening(&event),
                Err(_) => Opening::Wait,
            }
        }
        (_, Some(_)) => Opening::Content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Usage;

    #[test]
    fn kinds_are_read_from_the_first_bytes() {
        assert_eq!(
            kind(br#"{"type":"message_start","x":1}"#),
            Some(&b"message_start"[..])
        );
        assert_eq!(kind(br#"{ "type" : "error" }"#), Some(&b"error"[..]));
        assert_eq!(kind(br#"{"id":"c","type":"x"}"#), None);
        assert_eq!(kind(br#"{"type":"a\"b"}"#), None);
        assert_eq!(kind(br#"{"type":"open"#), None);
        assert_eq!(kind(b"[DONE]"), None);
    }

    #[test]
    fn lines_split_across_chunks_and_long_lines_pass() {
        let mut lines = Lines::default();
        let mut seen = Vec::new();
        let mut take = |chunk: &[u8], lines: &mut Lines| {
            let _: ControlFlow<()> = lines.feed(chunk, |l| {
                seen.push(String::from_utf8(l.to_vec()).unwrap());
                ControlFlow::Continue(())
            });
        };
        take(b"a\r\nb", &mut lines);
        take(b"c\n\nd", &mut lines);
        assert_eq!(lines.rest().as_deref(), Some(&b"d"[..]));
        let long = vec![b'x'; MAX_LINE + 1];
        take(&long, &mut lines);
        take(b"y\nz\n", &mut lines);
        assert_eq!(seen, ["a", "bc", "", "z"]);
    }

    #[test]
    fn claude_usage_merges_start_and_delta() {
        let mut tap = Tap::new(Dialect::Messages, Shape::Events);
        let stream = concat!(
            "event: message_start\n",
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}"#,
            "\n\nevent: content_block_delta\n",
            r#"data: {"type":"content_block_delta","delta":{"text":"usage error failed"}}"#,
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
        let mut tap = Tap::new(Dialect::Responses, Shape::Events);
        tap.feed(br#"data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":25},"output_tokens":40,"total_tokens":140}}}"#);
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
    fn chat_usage_comes_from_an_untyped_chunk() {
        let mut tap = Tap::new(Dialect::Chat, Shape::Events);
        tap.feed(b"data: {\"id\":\"c\",\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n");
        let usage = tap.finish().usage;
        assert_eq!((usage.input_tokens, usage.output_tokens), (9, 2));
    }

    #[test]
    fn whole_json_responses_report_usage() {
        let mut tap = Tap::new(Dialect::Messages, Shape::Json);
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
        let mut tap = Tap::new(Dialect::Responses, Shape::Json);
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
        let mut tap = Tap::new(Dialect::Messages, Shape::Opaque);
        tap.feed(b"\x1f\x8b");
        assert_eq!(tap.finish().usage.requests, 1);
    }

    #[test]
    fn in_stream_limits_are_exhaustion() {
        let mut tap = Tap::new(Dialect::Responses, Shape::Events);
        tap.feed(b"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\n");
        assert!(tap.finish().exhausted);
        let mut tap = Tap::new(Dialect::Messages, Shape::Events);
        tap.feed(b"data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n");
        assert!(tap.finish().exhausted);
    }

    #[test]
    fn openings_wait_for_a_telling_event() {
        let mut opener = Opener::new(Dialect::Responses);
        assert_eq!(
            opener.feed(b"event: response.created\ndata: {\"type\":\"response.created\"}\n\n"),
            Opening::Wait
        );
        assert_eq!(
            opener.feed(b"data: {\"type\":\"response.fai"),
            Opening::Wait
        );
        assert_eq!(
            opener.feed(b"led\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\n"),
            Opening::Refused { exhausted: true }
        );
        let mut opener = Opener::new(Dialect::Responses);
        assert_eq!(
            opener.feed(b"data: {\"type\":\"response.output_item.added\"}\n"),
            Opening::Content
        );
        let mut opener = Opener::new(Dialect::Responses);
        assert_eq!(
            opener.feed(
                b"data: {\"type\":\"error\",\"error\":{\"code\":\"context_length_exceeded\"}}\n"
            ),
            Opening::Content
        );
    }

    mod properties {
        use super::*;
        use proptest::prelude::*;

        const CODEX: &str = concat!(
            "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"usage error\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"input_tokens_details\":{\"cached_tokens\":25},\"output_tokens\":40}}}\n\n",
        );
        const CLAUDE: &str = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7,\"output_tokens\":1}}}\r\n\r\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"\\n\"}}\n\n",
            "data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":9}}",
        );

        fn split(text: &str, cuts: &[usize]) -> Vec<Vec<u8>> {
            let mut cuts: Vec<usize> = cuts.iter().map(|c| c % (text.len() + 1)).collect();
            cuts.sort_unstable();
            let mut out = Vec::new();
            let mut at = 0;
            for cut in cuts.into_iter().chain([text.len()]) {
                out.push(text.as_bytes()[at..cut].to_vec());
                at = cut;
            }
            out
        }

        proptest! {
            /// However a stream is cut into chunks, the tap and the opener
            /// reach what they reach on it whole.
            #[test]
            fn any_chunking_gives_the_same_outcome(cuts in prop::collection::vec(any::<usize>(), 0..12)) {
                for (dialect, text) in [(Dialect::Responses, CODEX), (Dialect::Messages, CLAUDE)] {
                    let mut whole = Tap::new(dialect, Shape::Events);
                    whole.feed(text.as_bytes());
                    let mut opener = Opener::new(dialect);
                    let opened_whole = opener.feed(text.as_bytes());
                    let mut tap = Tap::new(dialect, Shape::Events);
                    let mut opener = Opener::new(dialect);
                    let mut opened = Opening::Wait;
                    for chunk in split(text, &cuts) {
                        tap.feed(&chunk);
                        if opened == Opening::Wait {
                            opened = opener.feed(&chunk);
                        }
                    }
                    prop_assert_eq!(tap.finish(), whole.finish());
                    prop_assert_eq!(opened, opened_whole);
                }
            }

            /// Any bytes: no panic.
            #[test]
            fn arbitrary_streams_never_panic(chunks in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..64), 0..8)) {
                for dialect in [Dialect::Messages, Dialect::Responses, Dialect::Chat] {
                    let mut tap = Tap::new(dialect, Shape::Events);
                    let mut opener = Opener::new(dialect);
                    for chunk in &chunks {
                        tap.feed(chunk);
                        let _ = opener.feed(chunk);
                    }
                    let _ = tap.finish();
                }
            }
        }
    }
}
