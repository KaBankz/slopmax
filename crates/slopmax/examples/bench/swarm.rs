//! Many agents at once, as 10 Claude Code sessions with 30 subagents each
//! make: every session streams answers back to back, each answer's events
//! spaced like a model's tokens. What it measures is lag: how much later
//! than the mock sent it each event reaches the agent, and how long the
//! first byte takes. Run it against the mock directly, then through a proxy;
//! the difference is what the proxy adds.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use anyhow::Result;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame};
use slopmax_core::net::Client;
use slopmax_core::net::body::BoxError;
use tokio::time::{Instant, Sleep};

/// A body that sends one event every `pace`, on a fixed schedule from its
/// first poll, so a late poll does not push back the events after it.
pub struct Paced {
    frames: VecDeque<Bytes>,
    pace: Duration,
    start: Option<Instant>,
    sent: u32,
    sleep: Pin<Box<Sleep>>,
}

impl Paced {
    pub fn new(frames: Vec<Bytes>, pace: Duration) -> Self {
        Self {
            frames: frames.into(),
            pace,
            start: None,
            sent: 0,
            sleep: Box::pin(tokio::time::sleep(Duration::ZERO)),
        }
    }
}

impl Body for Paced {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = &mut *self;
        let start = *this.start.get_or_insert_with(Instant::now);
        if this.sent > 0 {
            let due = start + this.pace * this.sent;
            if Instant::now() < due {
                this.sleep.as_mut().reset(due);
                if this.sleep.as_mut().poll(cx).is_pending() {
                    return Poll::Pending;
                }
            }
        }
        this.sent += 1;
        Poll::Ready(this.frames.pop_front().map(|f| Ok(Frame::data(f))))
    }
}

#[derive(Default)]
struct Samples {
    /// Request sent to first byte, µs.
    first_byte: Vec<u32>,
    /// How much later than its schedule each event after the first came, µs.
    lag: Vec<u32>,
    /// Each event's gap from the one before, beyond the pace, µs.
    gap: Vec<u32>,
    answers: u64,
    failed: u64,
    events: u64,
}

pub async fn run(
    url: &str,
    sessions: usize,
    seconds: u64,
    body: Vec<u8>,
    pace_ms: u64,
) -> Result<()> {
    let url = format!("{}/v1/messages?beta=true", url.trim_end_matches('/'));
    let body = Bytes::from(body);
    // Every `SWARM_GPT_EVERY`th session asks for a GPT model, which slopmax
    // translates for a ChatGPT account: the heaviest work a request brings.
    let gpt_every: usize = std::env::var("SWARM_GPT_EVERY")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    let gpt =
        Bytes::from(String::from_utf8_lossy(&body).replacen("claude-opus-5-5", "gpt-6-sol", 1));
    let client = Client::builder().build();
    let pace = Duration::from_millis(pace_ms);
    let until = Instant::now() + Duration::from_secs(seconds);
    let all = Arc::new(Mutex::new(Samples::default()));
    let mut tasks = tokio::task::JoinSet::new();
    for session in 0..sessions {
        let body = if gpt_every > 0 && session % gpt_every == 0 {
            gpt.clone()
        } else {
            body.clone()
        };
        let (client, url, all) = (client.clone(), url.clone(), all.clone());
        tasks.spawn(async move {
            let mut mine = Samples::default();
            // Spread the starts over one answer, as agents do not work in
            // step; the first answer opens the connection and is not counted.
            tokio::time::sleep(pace * 64 * session as u32 / sessions.max(1) as u32).await;
            let _ = answer(&client, &url, &body, session, pace, &mut Samples::default()).await;
            while Instant::now() < until {
                // One answer per answer's length at most: a translated
                // answer is not paced, and should not run far more often.
                let next = Instant::now() + pace * 64;
                if answer(&client, &url, &body, session, pace, &mut mine)
                    .await
                    .is_err()
                {
                    mine.failed += 1;
                }
                tokio::time::sleep_until(next).await;
            }
            let mut all = all.lock().unwrap();
            all.first_byte.extend(mine.first_byte);
            all.lag.extend(mine.lag);
            all.gap.extend(mine.gap);
            all.answers += mine.answers;
            all.failed += mine.failed;
            all.events += mine.events;
        });
    }
    while tasks.join_next().await.is_some() {}
    let mut all = Arc::into_inner(all).unwrap().into_inner().unwrap();
    println!(
        "sessions {sessions}  answers {}  failed {}  events/s {:.0}",
        all.answers,
        all.failed,
        all.events as f64 / seconds as f64
    );
    for (name, values) in [
        ("first byte", &mut all.first_byte),
        ("event lag", &mut all.lag),
        ("event gap+", &mut all.gap),
    ] {
        values.sort_unstable();
        let at = |q: f64| {
            values
                .get(((values.len() as f64 - 1.0) * q).round() as usize)
                .map_or(0.0, |v| *v as f64 / 1000.0)
        };
        println!(
            "{name:<11} ms  p50 {:7.2}  p90 {:7.2}  p99 {:7.2}  p99.9 {:7.2}  max {:7.2}",
            at(0.5),
            at(0.9),
            at(0.99),
            at(0.999),
            at(1.0)
        );
    }
    Ok(())
}

async fn answer(
    client: &Client,
    url: &str,
    body: &Bytes,
    session: usize,
    pace: Duration,
    out: &mut Samples,
) -> Result<()> {
    let sent = Instant::now();
    let response = client
        .post(url)
        .header("authorization", "Bearer bench")
        .header("content-type", "application/json")
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .header("x-claude-code-session-id", format!("swarm-{session}"))
        .header("x-bench-pace-ms", pace.as_millis().to_string())
        .body(body.clone())
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "status {}",
        response.status()
    );
    let mut stream = response.into_body();
    let mut first: Option<Instant> = None;
    let mut last: Option<Instant> = None;
    let mut seen: u32 = 0;
    let mut newline = false;
    while let Some(frame) = stream.frame().await {
        let Ok(chunk) = frame.map_err(|e| anyhow::anyhow!(e))?.into_data() else {
            continue;
        };
        let now = Instant::now();
        // Events end in a blank line; one may straddle two chunks.
        for &byte in chunk.iter() {
            let ended = newline && byte == b'\n';
            newline = byte == b'\n' && !ended;
            if !ended {
                continue;
            }
            match first {
                None => {
                    first = Some(now);
                    out.first_byte.push(micros(now - sent));
                }
                Some(first) => {
                    let due = first + pace * seen;
                    out.lag.push(micros(now.saturating_duration_since(due)));
                    let gap = now - last.unwrap_or(first);
                    out.gap.push(micros(gap.saturating_sub(pace)));
                }
            }
            last = Some(now);
            seen += 1;
            out.events += 1;
        }
    }
    out.answers += 1;
    Ok(())
}

fn micros(d: Duration) -> u32 {
    d.as_micros().min(u32::MAX as u128) as u32
}
