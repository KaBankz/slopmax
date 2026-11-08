//! Holding back the start of a stream until it opens.
//!
//! A refusal can arrive inside a 200 stream, right after the response is
//! created. Holding the first events back for a moment lets the proxy see
//! it and move to another account before the agent has received anything.
//! Once content starts (or the wait runs out) the held bytes are sent first
//! and the stream passes through untouched.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Body;
use tokio::time::Instant;

use crate::net::body::BoxError;
use crate::wire::sse::Opener;
use crate::wire::{Dialect, Opening};

/// Longest the start is held: refusals arrive at once, and a slow first
/// token should not wait on this.
const WAIT: Duration = Duration::from_secs(3);
/// Most held back before giving up and streaming.
const LIMIT: usize = 256 * 1024;

pub enum Start<B> {
    /// Stream this: the held start, then the rest of `body`, then `broke`
    /// if the upstream broke the stream off while it was held.
    Streaming {
        held: Vec<Bytes>,
        body: B,
        broke: Option<BoxError>,
    },
    /// The stream opened with a refusal; these are the bytes received.
    Refused { exhausted: bool, held: Bytes },
}

pub async fn hold<B>(mut body: B, dialect: Dialect) -> Start<B>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    let deadline = Instant::now() + WAIT;
    let mut held: Vec<Bytes> = Vec::new();
    let mut size = 0;
    let mut opener = Opener::new(dialect);
    let mut broke = None;
    while size < LIMIT {
        let frame = match tokio::time::timeout_at(deadline, body.frame()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(e))) => {
                broke = Some(e.into());
                break;
            }
            // Waited long enough, or the stream ended: stream what came.
            Ok(None) | Err(_) => break,
        };
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        size += chunk.len();
        let told = opener.feed(&chunk);
        held.push(chunk);
        match told {
            Opening::Wait => {}
            Opening::Content => break,
            Opening::Refused { exhausted } => {
                return Start::Refused {
                    exhausted,
                    held: held.concat().into(),
                };
            }
        }
    }
    Start::Streaming { held, body, broke }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::body::{self, full};

    async fn streamed(start: Start<body::Body>) -> String {
        let Start::Streaming { held, body, broke } = start else {
            panic!("should stream");
        };
        assert!(broke.is_none());
        let rest = body::read(body, usize::MAX).await.unwrap();
        String::from_utf8([held.concat(), rest.to_vec()].concat()).unwrap()
    }

    #[tokio::test]
    async fn content_streams_with_the_held_start_first() {
        let stream = "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.output_item.added\"}\n\ndata: {\"type\":\"response.completed\"}\n\n";
        assert_eq!(
            streamed(hold(full(stream), Dialect::Responses).await).await,
            stream
        );
    }

    #[tokio::test]
    async fn a_spent_quota_is_caught_before_the_agent_sees_it() {
        let stream = "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\n\n";
        match hold(full(stream), Dialect::Responses).await {
            Start::Refused { exhausted, held } => {
                assert!(exhausted);
                assert_eq!(held, stream);
            }
            Start::Streaming { .. } => panic!("should be refused"),
        }
    }

    #[tokio::test]
    async fn request_failures_go_to_the_agent() {
        let stream = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"context_length_exceeded\"}}}\n\n";
        assert_eq!(
            streamed(hold(full(stream), Dialect::Responses).await).await,
            stream
        );
    }
}
