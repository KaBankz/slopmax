//! Body types shared by the server and the client.

use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, Limited};
use hyper::body::{Body as HttpBody, Frame, SizeHint};
use tokio::time::{Instant, Sleep};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A response body: buffered, empty, or streamed from upstream.
pub type Body = UnsyncBoxBody<Bytes, BoxError>;

pub fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

pub fn empty() -> Body {
    Empty::new().map_err(|never| match never {}).boxed_unsync()
}

/// Boxes any body whose errors convert to [`BoxError`].
pub fn boxed<B>(body: B) -> Body
where
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    body.map_err(Into::into).boxed_unsync()
}

/// Reads a whole body, failing once it exceeds `limit` bytes.
pub async fn read<B>(body: B, limit: usize) -> Result<Bytes, BoxError>
where
    B: HttpBody<Data = Bytes>,
    B::Error: Into<BoxError>,
{
    Limited::new(body, limit)
        .collect()
        .await
        .map(|collected| collected.to_bytes())
}

/// Fails a body that sends nothing for `idle`: a stalled upstream stream
/// should not hold a connection open forever.
pub struct IdleTimeout<B> {
    inner: B,
    idle: Duration,
    sleep: Pin<Box<Sleep>>,
}

impl<B> IdleTimeout<B> {
    pub fn new(inner: B, idle: Duration) -> Self {
        Self {
            inner,
            idle,
            sleep: Box::pin(tokio::time::sleep(idle)),
        }
    }
}

#[derive(Debug)]
pub struct Stalled(Duration);

impl std::fmt::Display for Stalled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "no data for {}s", self.0.as_secs())
    }
}

impl std::error::Error for Stalled {}

impl<B> HttpBody for IdleTimeout<B>
where
    B: HttpBody<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if let Poll::Ready(frame) = Pin::new(&mut self.inner).poll_frame(cx) {
            let deadline = Instant::now() + self.idle;
            self.sleep.as_mut().reset(deadline);
            return Poll::Ready(frame.map(|f| f.map_err(Into::into)));
        }
        ready!(self.sleep.as_mut().poll(cx));
        Poll::Ready(Some(Err(Stalled(self.idle).into())))
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_within_the_limit() {
        assert_eq!(read(full("hello"), 5).await.unwrap(), "hello");
        assert!(read(full("hello"), 4).await.is_err());
    }

    /// A body that never produces a frame.
    struct Silent;

    impl HttpBody for Silent {
        type Data = Bytes;
        type Error = BoxError;

        fn poll_frame(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            Poll::Pending
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_bodies_fail() {
        let body = IdleTimeout::new(Silent, Duration::from_secs(5));
        let err = read(body, 10).await.unwrap_err();
        assert_eq!(err.to_string(), "no data for 5s");
    }
}
