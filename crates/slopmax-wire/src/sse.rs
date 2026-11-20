//! Server-sent events as they stream past.
//!
//! [`Lines`] splits chunks into lines, borrowing a line that lies within one
//! chunk and buffering only one split across two. [`kind`] reads an event's
//! `type` from its first bytes, so the token deltas that are nearly every
//! event of an answer are passed over without being parsed; only the few
//! events that carry usage or a refusal are. [`Tap`] collects what a
//! finished stream said, and [`Opener`] judges how one opens.

use std::ops::ControlFlow;

use miniz_oxide::inflate::stream::{InflateState, inflate};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};
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
    /// usage, a refusal, or the start of an advisor call. Deltas cannot.
    pub fn observes(self, kind: &[u8]) -> bool {
        match self {
            Self::Messages => matches!(
                kind,
                b"message_start"
                    | b"message_delta"
                    | b"message"
                    | b"error"
                    | b"content_block_start"
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
    /// Compressed as `coding`, read through a decoder as events, or as JSON
    /// when `json`. The bytes that pass on stay compressed.
    Compressed { coding: Coding, json: bool },
    /// Compressed some way slopmax does not read: passed through unread;
    /// only the request counts.
    Opaque,
}

/// A `content-encoding` slopmax can decode to read a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coding {
    Gzip,
    /// HTTP's `deflate`, which is zlib-wrapped.
    Deflate,
}

impl Shape {
    /// The shape of a body sent with these `content-encoding` and
    /// `content-type` headers.
    pub fn of(encoding: Option<&str>, content_type: Option<&str>) -> Self {
        let json = content_type.is_some_and(|v| v.contains("json"));
        let coding = match encoding.map(str::trim) {
            None | Some("") => None,
            Some(e) if e.eq_ignore_ascii_case("identity") => None,
            Some(e) if e.eq_ignore_ascii_case("gzip") || e.eq_ignore_ascii_case("x-gzip") => {
                Some(Coding::Gzip)
            }
            Some(e) if e.eq_ignore_ascii_case("deflate") => Some(Coding::Deflate),
            Some(_) => return Self::Opaque,
        };
        match coding {
            Some(coding) => Self::Compressed { coding, json },
            None if json => Self::Json,
            None => Self::Events,
        }
    }
}

/// Decompresses a copy of a compressed body as it streams past.
struct Inflate {
    state: Box<InflateState>,
    /// Gzip: the header read so far, until the deflate data starts.
    header: Option<Vec<u8>>,
    /// The compressed data ended; what follows (gzip's trailer) is skipped.
    done: bool,
}

impl std::fmt::Debug for Inflate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inflate")
            .field("header", &self.header.as_ref().map(Vec::len))
            .field("done", &self.done)
            .finish_non_exhaustive()
    }
}

/// Longest gzip header held while it is read; its name and comment fields
/// have no length of their own.
const MAX_GZIP_HEADER: usize = 64 * 1024;

impl Inflate {
    fn new(coding: Coding) -> Self {
        let (format, header) = match coding {
            Coding::Gzip => (DataFormat::Raw, Some(Vec::new())),
            Coding::Deflate => (DataFormat::Zlib, None),
        };
        Self {
            state: InflateState::new_boxed(format),
            header,
            done: false,
        }
    }

    /// What `chunk` decompresses to, or `None` once the body is not what
    /// its encoding says.
    fn feed(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        let held;
        let mut input = chunk;
        if let Some(header) = self.header.as_mut() {
            header.extend_from_slice(chunk);
            let start = match gzip_header(header) {
                GzipHeader::Partial if header.len() <= MAX_GZIP_HEADER => {
                    return Some(Vec::new());
                }
                GzipHeader::Partial | GzipHeader::Invalid => return None,
                GzipHeader::Ends(at) => at,
            };
            held = self.header.take().unwrap_or_default();
            input = &held[start..];
        }
        let mut plain = Vec::new();
        let mut out = [0u8; 16 * 1024];
        while !self.done {
            let step = inflate(&mut self.state, input, &mut out, MZFlush::None);
            plain.extend_from_slice(&out[..step.bytes_written]);
            input = &input[step.bytes_consumed..];
            match step.status {
                Ok(MZStatus::StreamEnd) => self.done = true,
                Ok(_) => {}
                // No progress: it needs the next chunk.
                Err(MZError::Buf) => break,
                Err(_) => return None,
            }
            if input.is_empty() && step.bytes_written < out.len() {
                break;
            }
        }
        Some(plain)
    }
}

/// A whole gzip file decompressed, or `None` if it is not one. At most
/// `limit` bytes come out: a file that says more is refused.
pub fn gunzip(bytes: &[u8], limit: usize) -> Option<Vec<u8>> {
    let GzipHeader::Ends(start) = gzip_header(bytes) else {
        return None;
    };
    // The deflate data, then CRC-32 and the size, eight bytes.
    let data = bytes.get(start..bytes.len().checked_sub(8)?)?;
    inflate_raw(data, limit)
}

/// Raw deflate data (RFC 1951) decompressed, or `None` if it does not
/// decompress or comes to more than `limit` bytes.
pub fn inflate_raw(data: &[u8], limit: usize) -> Option<Vec<u8>> {
    miniz_oxide::inflate::decompress_to_vec_with_limit(data, limit).ok()
}

/// A whole zstd frame decompressed, or `None` if it does not decompress or
/// comes to more than `limit` bytes.
pub fn unzstd(bytes: &[u8], limit: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let decoder = ruzstd::decoding::StreamingDecoder::new(bytes).ok()?;
    let mut out = Vec::new();
    decoder.take(limit as u64 + 1).read_to_end(&mut out).ok()?;
    (out.len() <= limit).then_some(out)
}

/// A request body decompressed as its `content-encoding` says, or `None`
/// for an encoding slopmax does not read or a body that does not
/// decompress to at most `limit` bytes.
pub fn decompress(encoding: &[u8], bytes: &[u8], limit: usize) -> Option<Vec<u8>> {
    match encoding {
        b"zstd" => unzstd(bytes, limit),
        b"gzip" | b"x-gzip" => gunzip(bytes, limit),
        _ => None,
    }
}

/// How far a gzip header (RFC 1952) has been read.
#[derive(Debug, PartialEq, Eq)]
enum GzipHeader {
    /// It may still be one; more bytes are needed.
    Partial,
    Invalid,
    /// It ends here, where the deflate data starts.
    Ends(usize),
}

fn gzip_header(bytes: &[u8]) -> GzipHeader {
    const MAGIC: [u8; 3] = [0x1f, 0x8b, 8];
    const FHCRC: u8 = 0x02;
    const FEXTRA: u8 = 0x04;
    const FNAME: u8 = 0x08;
    const FCOMMENT: u8 = 0x10;
    if !bytes.iter().zip(MAGIC).all(|(b, m)| *b == m) {
        return GzipHeader::Invalid;
    }
    if bytes.len() < 10 {
        return GzipHeader::Partial;
    }
    let flags = bytes[3];
    let mut at = 10;
    if flags & FEXTRA != 0 {
        let Some(&[lo, hi]) = bytes.get(at..at + 2) else {
            return GzipHeader::Partial;
        };
        at += 2 + usize::from(u16::from_le_bytes([lo, hi]));
    }
    for field in [FNAME, FCOMMENT] {
        if flags & field != 0 {
            let rest = bytes.get(at..).unwrap_or_default();
            let Some(end) = memchr::memchr(0, rest) else {
                return GzipHeader::Partial;
            };
            at += end + 1;
        }
    }
    if flags & FHCRC != 0 {
        at += 2;
    }
    if bytes.len() < at {
        GzipHeader::Partial
    } else {
        GzipHeader::Ends(at)
    }
}

/// Watches a response go by and says, at its end, what it reported: token
/// usage, and whether the account's quota ran out inside it.
#[derive(Debug)]
pub struct Tap {
    dialect: Dialect,
    /// How the body reads once decompressed: never [`Shape::Compressed`].
    shape: Shape,
    /// Decompresses a compressed body before it is read.
    inflate: Option<Inflate>,
    lines: Lines,
    /// A JSON body, collected whole.
    whole: Vec<u8>,
    overflow: bool,
    outcome: Outcome,
}

impl Tap {
    pub fn new(dialect: Dialect, shape: Shape) -> Self {
        let (shape, inflate) = match shape {
            Shape::Compressed { coding, json } => {
                let shape = if json { Shape::Json } else { Shape::Events };
                (shape, Some(Inflate::new(coding)))
            }
            shape => (shape, None),
        };
        Self {
            dialect,
            shape,
            inflate,
            lines: Lines::default(),
            whole: Vec::new(),
            overflow: false,
            outcome: Outcome::default(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        let Some(inflate) = self.inflate.as_mut() else {
            return self.read(chunk);
        };
        match inflate.feed(chunk) {
            Some(plain) => self.read(&plain),
            None => self.unreadable(),
        }
    }

    /// A body that fails to decompress is passed over unread from there on,
    /// as an unknown encoding is: what reaches the agent is untouched.
    fn unreadable(&mut self) {
        self.inflate = None;
        self.shape = Shape::Opaque;
        self.whole = Vec::new();
    }

    fn read(&mut self, chunk: &[u8]) {
        match self.shape {
            Shape::Compressed { .. } | Shape::Opaque => {}
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
        // Each chunk was decompressed as it came; a cut-off body is read as
        // far as it went.
        self.inflate = None;
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
            Shape::Json | Shape::Compressed { .. } | Shape::Opaque => {}
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
    if !worth {
        return;
    }
    let read = match dialect {
        Dialect::Messages => crate::messages::observe_raw(data, outcome),
        Dialect::Responses => crate::responses::observe_raw(data, outcome),
        Dialect::Chat => false,
    };
    // Another shape than the typed reader expects: read it as a value.
    if !read && let Ok(event) = serde_json::from_slice::<Value>(data) {
        dialect.observe(&event, outcome);
    }
}

/// Judges how a stream opens, event by event, for [`Dialect::holds_start`].
#[derive(Debug)]
pub struct Opener {
    dialect: Dialect,
    lines: Lines,
    refusal: Option<Value>,
}

impl Opener {
    pub fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            lines: Lines::default(),
            refusal: None,
        }
    }

    /// The first telling event in `chunk`, or [`Opening::Wait`].
    pub fn feed(&mut self, chunk: &[u8]) -> Opening {
        let dialect = self.dialect;
        let refusal = &mut self.refusal;
        let flow = self.lines.feed(chunk, |line| match opening(dialect, line) {
            (Opening::Wait, _) => ControlFlow::Continue(()),
            (told, event) => {
                if matches!(told, Opening::Refused { .. }) {
                    *refusal = event;
                }
                ControlFlow::Break(told)
            }
        });
        match flow {
            ControlFlow::Break(told) => told,
            ControlFlow::Continue(()) => Opening::Wait,
        }
    }

    /// The event the stream was refused with, for the wait it names.
    pub fn refusal(self) -> Option<Value> {
        self.refusal
    }
}

/// How `line` opens a stream, with the event when it was read whole.
fn opening(dialect: Dialect, line: &[u8]) -> (Opening, Option<Value>) {
    let Some(data) = data(line) else {
        return (Opening::Wait, None);
    };
    match (dialect, kind(data)) {
        (
            Dialect::Responses,
            Some(b"response.created" | b"response.in_progress" | b"response.queued"),
        ) => (Opening::Wait, None),
        (Dialect::Responses, Some(b"response.failed" | b"error")) | (_, None) => {
            match serde_json::from_slice::<Value>(data) {
                Ok(event) => (dialect.opening(&event), Some(event)),
                Err(_) => (Opening::Wait, None),
            }
        }
        (_, Some(_)) => (Opening::Content, None),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

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

    fn gzip(plain: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(plain).unwrap();
        e.finish().unwrap()
    }

    const CLAUDE_STREAM: &[u8] = b"event: message_start\n\
        data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7,\"cache_read_input_tokens\":300,\"output_tokens\":1}}}\n\n\
        event: content_block_delta\n\
        data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n\
        event: message_delta\n\
        data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n";

    #[test]
    fn gzipped_streams_are_read_for_usage() {
        // Anthropic gzips Claude Code's streams; they arrive in any split.
        let body = gzip(CLAUDE_STREAM);
        for size in [1, 7, body.len()] {
            let mut tap = Tap::new(
                Dialect::Messages,
                Shape::of(Some("gzip"), Some("text/event-stream; charset=utf-8")),
            );
            for chunk in body.chunks(size) {
                tap.feed(chunk);
            }
            let usage = tap.finish().usage;
            assert_eq!(
                (
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_tokens
                ),
                (7, 5, 300),
                "chunks of {size}"
            );
        }
    }

    #[test]
    fn gzip_headers_with_every_optional_field_are_read() {
        let mut e = flate2::GzBuilder::new()
            .filename("answer.txt")
            .comment("from a test")
            .extra(vec![1, 2, 3])
            .write(Vec::new(), flate2::Compression::fast());
        e.write_all(CLAUDE_STREAM).unwrap();
        let body = e.finish().unwrap();
        let mut tap = Tap::new(Dialect::Messages, Shape::of(Some("gzip"), None));
        for byte in &body {
            tap.feed(std::slice::from_ref(byte));
        }
        assert_eq!(tap.finish().usage.output_tokens, 5);

        assert_eq!(gzip_header(b"\x1f"), GzipHeader::Partial);
        assert_eq!(gzip_header(b"data: {"), GzipHeader::Invalid);
        assert_eq!(
            gzip_header(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"),
            GzipHeader::Ends(10)
        );
        // A name with no end yet.
        assert_eq!(
            gzip_header(b"\x1f\x8b\x08\x08\x00\x00\x00\x00\x00\xffname"),
            GzipHeader::Partial
        );
    }

    /// Grok Build sends its model requests zstd-compressed once xAI's
    /// settings say the API takes them so.
    #[test]
    fn compressed_request_bodies_are_read_up_to_a_limit() {
        let json = br#"{"input":[{"role":"user","content":"hi"}],"model":"grok-4.7"}"#;
        let zstd = ruzstd::encoding::compress_to_vec(
            &json[..],
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        assert_eq!(&zstd[..4], b"\x28\xb5\x2f\xfd");
        assert_eq!(
            decompress(b"zstd", &zstd, 1 << 20).as_deref(),
            Some(&json[..])
        );
        assert_eq!(
            decompress(b"zstd", &zstd, json.len()).as_deref(),
            Some(&json[..])
        );
        assert_eq!(decompress(b"zstd", &zstd, json.len() - 1), None);
        assert_eq!(decompress(b"zstd", &zstd[..zstd.len() / 2], 1 << 20), None);
        assert_eq!(decompress(b"zstd", json, 1 << 20), None);

        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(json).unwrap();
        let gzip = e.finish().unwrap();
        assert_eq!(
            decompress(b"gzip", &gzip, 1 << 20).as_deref(),
            Some(&json[..])
        );
        // Encodings slopmax does not read are left alone.
        assert_eq!(decompress(b"br", &gzip, 1 << 20), None);
    }

    #[test]
    fn deflated_json_is_read_for_usage() {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(
            br#"{"type":"message","content":[],"usage":{"input_tokens":12,"output_tokens":3}}"#,
        )
        .unwrap();
        let mut tap = Tap::new(
            Dialect::Messages,
            Shape::of(Some("deflate"), Some("application/json")),
        );
        tap.feed(&e.finish().unwrap());
        let usage = tap.finish().usage;
        assert_eq!((usage.input_tokens, usage.output_tokens), (12, 3));
    }

    #[test]
    fn a_body_that_does_not_decompress_counts_only_the_request() {
        let mut tap = Tap::new(Dialect::Messages, Shape::of(Some("gzip"), None));
        tap.feed(b"\x1f\x8b\x08\x00not gzip at all");
        tap.feed(CLAUDE_STREAM);
        let outcome = tap.finish();
        assert_eq!(outcome.usage.requests, 1);
        assert_eq!(outcome.usage.total_tokens(), 0);
    }

    #[test]
    fn shape_follows_the_encoding_and_type() {
        let events = Some("text/event-stream");
        let json = Some("application/json");
        assert_eq!(Shape::of(None, events), Shape::Events);
        assert_eq!(Shape::of(Some("identity"), json), Shape::Json);
        assert_eq!(
            Shape::of(Some("GZIP"), events),
            Shape::Compressed {
                coding: Coding::Gzip,
                json: false
            }
        );
        assert_eq!(
            Shape::of(Some("deflate"), json),
            Shape::Compressed {
                coding: Coding::Deflate,
                json: true
            }
        );
        assert_eq!(Shape::of(Some("br"), events), Shape::Opaque);
        assert_eq!(Shape::of(Some("zstd"), events), Shape::Opaque);
        assert_eq!(Shape::of(Some("gzip, br"), events), Shape::Opaque);
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
        assert_eq!(
            opener.refusal().unwrap()["response"]["error"]["code"],
            "usage_limit_reached",
            "the refusal is kept for the wait it names"
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

        /// An event of `kind` with numbers, nulls and odd shapes in the
        /// places the readers look.
        fn event() -> impl Strategy<Value = (Dialect, String)> {
            let count = prop_oneof![
                Just("null".to_owned()),
                (0u64..5000).prop_map(|n| n.to_string()),
                Just("\"7\"".to_owned()),
            ];
            let usage = (count.clone(), count.clone(), count.clone(), count).prop_map(|(a, b, c, d)| {
                format!(r#"{{"input_tokens":{a},"output_tokens":{b},"cache_read_input_tokens":{c},"cache_creation_input_tokens":{d},"input_tokens_details":{{"cached_tokens":{c}}}}}"#)
            });
            let error = prop_oneof![
                Just(r#"{"type":"rate_limit_error"}"#.to_owned()),
                Just(r#"{"code":"usage_limit_reached"}"#.to_owned()),
                Just(r#"{"type":"overloaded_error","code":null}"#.to_owned()),
                Just(r#""a string""#.to_owned()),
                Just("null".to_owned()),
            ];
            (
                prop::sample::select(vec![Dialect::Messages, Dialect::Responses]),
                prop::sample::select(vec![
                    "message_start",
                    "message_delta",
                    "message",
                    "error",
                    "response.completed",
                    "response.incomplete",
                    "response.failed",
                ]),
                usage,
                error,
                0..4u8,
            )
                .prop_map(|(dialect, kind, usage, error, shape)| {
                    let body = match shape {
                        0 => format!(r#""message":{{"usage":{usage}}},"usage":{usage}"#),
                        1 => format!(r#""response":{{"usage":{usage},"error":{error}}}"#),
                        2 => format!(r#""error":{error},"usage":{usage}"#),
                        _ => r#""response":null,"message":"text""#.to_string(),
                    };
                    (dialect, format!(r#"{{"type":"{kind}",{body}}}"#))
                })
        }

        proptest! {
            /// The typed readers and the value readers agree on every event.
            #[test]
            fn typed_and_value_readers_agree((dialect, data) in event()) {
                let value: Value = serde_json::from_str(&data).unwrap();
                let mut by_value = Outcome::default();
                dialect.observe(&value, &mut by_value);
                let mut typed = Outcome::default();
                let read = match dialect {
                    Dialect::Messages => crate::messages::observe_raw(data.as_bytes(), &mut typed),
                    _ => crate::responses::observe_raw(data.as_bytes(), &mut typed),
                };
                if read {
                    prop_assert_eq!(typed, by_value, "{}", data);
                }
            }

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
