//! Holding back the start of a stream until it opens.
//!
//! A refusal can arrive inside a 200 stream, right after the response is
//! created. Holding the first events back for a moment lets the proxy see
//! it and move to another account before the agent has received anything.
//! Once content starts (or the wait runs out) the held bytes are replayed
//! and the stream passes through untouched.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::time::Instant;

use crate::net::body::{self, Body, Prefixed};
use crate::wire::{Dialect, Opening};

/// Longest the start is held: refusals arrive at once, and a slow first
/// token should not wait on this.
const WAIT: Duration = Duration::from_secs(3);
/// Most held back before giving up and streaming.
const LIMIT: usize = 256 * 1024;

pub enum Start {
    /// Stream this (the held start, then the rest).
    Streaming(Body),
    /// The stream opened with a refusal; these are the bytes received.
    Refused { exhausted: bool, held: Bytes },
}

pub async fn hold(mut body: Body, dialect: Dialect) -> Start {
    let deadline = Instant::now() + WAIT;
    let mut held: Vec<Bytes> = Vec::new();
    let mut size = 0;
    let mut line: Vec<u8> = Vec::new();
    while size < LIMIT {
        let frame = match tokio::time::timeout_at(deadline, body.frame()).await {
            Ok(Some(Ok(frame))) => frame,
            // Waited long enough, ended, or failed: let the stream say so.
            _ => break,
        };
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        size += chunk.len();
        held.push(chunk.clone());
        for &byte in chunk.iter() {
            if byte != b'\n' {
                line.push(byte);
                continue;
            }
            let opening = event(&line).map_or(Opening::Wait, |e| dialect.opening(&e));
            line.clear();
            match opening {
                Opening::Wait => {}
                Opening::Content => return Start::Streaming(replay(held, body)),
                Opening::Refused { exhausted } => {
                    return Start::Refused {
                        exhausted,
                        held: held.concat().into(),
                    };
                }
            }
        }
    }
    Start::Streaming(replay(held, body))
}

fn replay(held: Vec<Bytes>, rest: Body) -> Body {
    body::boxed(Prefixed::new(held, rest))
}

/// The JSON of an SSE `data:` line.
fn event(line: &[u8]) -> Option<Value> {
    let data = line.strip_prefix(b"data:")?.trim_ascii();
    serde_json::from_slice(data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::body::full;

    async fn read(body: Body) -> String {
        String::from_utf8(body::read(body, usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn content_streams_with_the_held_start_replayed() {
        let stream = "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.output_item.added\"}\n\ndata: {\"type\":\"response.completed\"}\n\n";
        match hold(full(stream), Dialect::Responses).await {
            Start::Streaming(body) => assert_eq!(read(body).await, stream),
            Start::Refused { .. } => panic!("content is not a refusal"),
        }
    }

    #[tokio::test]
    async fn a_spent_quota_is_caught_before_the_agent_sees_it() {
        let stream = "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\n\n";
        match hold(full(stream), Dialect::Responses).await {
            Start::Refused { exhausted, held } => {
                assert!(exhausted);
                assert_eq!(held, stream);
            }
            Start::Streaming(_) => panic!("should be refused"),
        }
    }

    #[tokio::test]
    async fn request_failures_go_to_the_agent() {
        let stream = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"context_length_exceeded\"}}}\n\n";
        assert!(matches!(
            hold(full(stream), Dialect::Responses).await,
            Start::Streaming(_)
        ));
    }
}
