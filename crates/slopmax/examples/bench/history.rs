//! What the dashboard waits for on `/slopmax/api/history` and
//! `/slopmax/api/requests`: a ledger written as one machine's would be,
//! then the daemon serving it and asked for each range over one kept-alive
//! connection, so the time is the HTTP round trip with the answer.
//!
//! ```sh
//! bench history-ledger /tmp/home 365 6000
//! bench history /tmp/home 300 /tmp/out
//! ```
//!
//! The ledger is written once and read by each build to compare: the
//! answers `history` saves to `<out>/history-<range>.json` match byte for
//! byte on the same ledger within the same local day.

use std::io::{BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use slopmax_core::config::Config;
use slopmax_core::ledger::{Entry, month_name};
use slopmax_core::net::Origins;
use slopmax_core::paths::Home;
use slopmax_core::provider::ProviderId;
use slopmax_core::time::{SignedDuration, Timestamp};

/// Each provider's models, the busiest first, with their share in tenths.
const MODELS: [(ProviderId, &[(&str, u64)]); 2] = [
    (
        ProviderId::Claude,
        &[
            ("claude-opus-5-5", 6),
            ("claude-sonnet-4-5", 3),
            ("claude-haiku-4-5", 1),
        ],
    ),
    (
        ProviderId::Codex,
        &[("gpt-6-sol", 7), ("gpt-6-sol-mini", 3)],
    ),
];

/// A small generator, so every ledger written with the same numbers is the
/// same one.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Writes `days` of ledger up to now into `home`, about `per_day` answers
/// a day, from the bench's four accounts: mostly Claude Code on two Claude
/// accounts, the rest Codex on two ChatGPT ones; busier in working hours,
/// in conversations of about an hour; a few rescued, failed or refused,
/// and a few warmups.
pub fn ledger(home: &str, days: i64, per_day: u64) -> Result<()> {
    let home = Home::at(home);
    let accounts = super::accounts(&home)?;
    let ids = |provider| -> Vec<String> {
        accounts
            .iter()
            .filter(|a| a.provider == provider)
            .map(|a| a.id.clone())
            .collect()
    };
    let (claude, codex) = (ids(ProviderId::Claude), ids(ProviderId::Codex));
    let dir = home.usage();
    std::fs::create_dir_all(&dir)?;
    // Whole minutes, so the same `now` gives the same ledger.
    let now = Timestamp::from_second(Timestamp::now().as_second() / 60 * 60).context("now")?;
    let start = now - SignedDuration::from_hours(24 * days);
    // How busy each hour of the day is, in parts of the day's answers.
    let weight: [u64; 24] = [
        1, 1, 0, 0, 0, 0, 1, 2, 5, 9, 10, 10, 7, 9, 10, 10, 9, 8, 6, 4, 4, 3, 2, 1,
    ];
    let parts: u64 = weight.iter().sum();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut file: Option<(String, BufWriter<std::fs::File>)> = None;
    let mut line = Vec::new();
    let mut written = 0u64;
    for minute in 0..days * 24 * 60 {
        let at = start + SignedDuration::from_mins(minute);
        let hour = (at.as_second() + at.local_offset().as_secs()).rem_euclid(86_400) / 3_600;
        // Answers this minute, on average the hour's share of the day's.
        let rate = per_day * weight[hour as usize] * 1_000 / parts / 60;
        let n = (rate + rng.below(1_000)) / 1_000;
        for _ in 0..n {
            let codex_turn = rng.below(10) < 3;
            let (provider, ids) = if codex_turn {
                (ProviderId::Codex, &codex)
            } else {
                (ProviderId::Claude, &claude)
            };
            let models = MODELS.iter().find(|(p, _)| *p == provider).unwrap().1;
            let mut pick = rng.below(10);
            let model = models
                .iter()
                .find(|(_, share)| {
                    let hit = pick < *share;
                    pick = pick.saturating_sub(*share);
                    hit
                })
                .map_or(models[0].0, |(m, _)| m);
            let roll = rng.below(1_000);
            let warmup = roll < 5;
            let failed = (5..20).contains(&roll);
            let refused = (20..23).contains(&roll);
            let rescued = (23..60).contains(&roll);
            let output = 80 + rng.below(2_400);
            let first_byte = 350 + rng.below(2_500);
            let writing = output * 1_000 / (40 + rng.below(120));
            // A conversation runs about an hour; a few at once.
            let session = (!warmup).then(|| {
                format!(
                    "{}-{:08x}-{}",
                    provider.as_str(),
                    minute / 60,
                    rng.below(3 + per_day / 2_000)
                )
            });
            let entry = Entry {
                at: at + SignedDuration::from_secs(rng.below(60) as i64),
                account: if refused {
                    String::new()
                } else {
                    ids[rng.below(ids.len() as u64) as usize].clone()
                },
                provider,
                model: Some(model.to_owned()),
                status: if failed || refused { 429 } else { 200 },
                input: if failed || refused {
                    0
                } else {
                    20 + rng.below(4_000)
                },
                output: if failed || refused { 0 } else { output },
                cache_read: if failed || refused || warmup {
                    0
                } else {
                    rng.below(180_000)
                },
                cache_write: if failed || refused {
                    0
                } else {
                    rng.below(6_000)
                },
                ms: first_byte + writing,
                first_byte_ms: (!(failed || refused)).then_some(first_byte),
                attempts: if rescued { 2 } else { 1 },
                agent: Some(
                    if warmup {
                        "slopmax"
                    } else if codex_turn {
                        "codex"
                    } else {
                        "claude"
                    }
                    .to_owned(),
                ),
                session,
                end: None,
                machine: None,
            };
            let name = month_name(entry.at);
            if file.as_ref().is_none_or(|(open, _)| *open != name) {
                if let Some((_, mut done)) = file.take() {
                    done.flush()?;
                }
                let opened = std::fs::File::create(dir.join(&name))?;
                file = Some((name, BufWriter::new(opened)));
            }
            line.clear();
            serde_json::to_writer(&mut line, &entry)?;
            line.push(b'\n');
            file.as_mut().unwrap().1.write_all(&line)?;
            written += 1;
        }
    }
    if let Some((_, mut done)) = file {
        done.flush()?;
    }
    eprintln!(
        "{written} requests over {days} days written to {}",
        dir.display()
    );
    Ok(())
}

/// Serves `home` and asks for each range: once first, `settle` seconds
/// after the daemon answers (while or after it builds its indexes), then
/// `rounds` times warm. Saves each answer under `out`.
pub fn serve(home: &str, rounds: usize, out: &str, settle: u64) -> Result<()> {
    let home = Home::at(home);
    let listen: SocketAddr = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0")?;
        probe.local_addr()?
    };
    let config = Config {
        listen,
        api_key: "bench".into(),
        refresh_tokens: false,
        poll_mins: 0,
        ..Config::default()
    };
    // Nothing reaches a provider: every upstream is a closed port.
    let origins = Origins::new([
        ("https://api.anthropic.com", "http://127.0.0.1:9"),
        ("https://chatgpt.com/backend-api", "http://127.0.0.1:9"),
    ]);
    std::thread::spawn(move || {
        let runtime = slopmax_daemon::runtime().expect("a runtime");
        if let Err(e) = runtime.block_on(slopmax_daemon::serve(config, home, origins)) {
            eprintln!("serve: {e:#}");
            std::process::exit(1);
        }
    });
    let mut conn = connect(listen)?;
    std::thread::sleep(Duration::from_secs(settle));
    std::fs::create_dir_all(out)?;
    for range in ["today", "7d", "30d"] {
        let path = format!("/slopmax/api/history?range={range}");
        let started = Instant::now();
        let body = conn.get(&path)?;
        let first = started.elapsed();
        let mut times: Vec<Duration> = (0..rounds)
            .map(|_| {
                let started = Instant::now();
                let again = conn.get(&path)?;
                let took = started.elapsed();
                if again != body {
                    bail!("{range}: the answer changed between rounds");
                }
                Ok(took)
            })
            .collect::<Result<_>>()?;
        times.sort();
        let at = |p: usize| times[(times.len() * p / 100).min(times.len() - 1)];
        let ms = |d: Duration| d.as_secs_f64() * 1e3;
        println!(
            "{range:>5}: first {:8.2} ms, warm min {:.3} p50 {:.3} p90 {:.3} ms, {} bytes",
            ms(first),
            ms(times[0]),
            ms(at(50)),
            ms(at(90)),
            body.len()
        );
        std::fs::write(Path::new(out).join(format!("history-{range}.json")), &body)?;
    }
    // A page of requests, the overview's latest few, and a filtered page,
    // as the TUI and the dashboard ask for them after each new request.
    let pages = [
        ("today", "page", "range=today&limit=100"),
        ("today", "latest", "range=today&limit=6"),
        ("today", "failed", "range=today&outcome=failed&limit=100"),
        ("7d", "page", "range=7d&limit=100"),
        ("30d", "page", "range=30d&limit=100"),
        ("30d", "model", "range=30d&model=claude-haiku-4-5&limit=100"),
    ];
    let rounds = rounds.clamp(1, 20);
    for (range, what, query) in pages {
        let path = format!("/slopmax/api/requests?{query}");
        let mut times: Vec<Duration> = (0..rounds)
            .map(|_| {
                let started = Instant::now();
                conn.get(&path)?;
                Ok(started.elapsed())
            })
            .collect::<Result<_>>()?;
        times.sort();
        let ms = |d: Duration| d.as_secs_f64() * 1e3;
        println!(
            "requests {range:>5} {what:<6}: min {:9.2} p50 {:9.2} max {:9.2} ms",
            ms(times[0]),
            ms(times[times.len() / 2]),
            ms(times[times.len() - 1]),
        );
    }
    Ok(())
}

/// One kept-alive connection to the daemon's API.
struct Conn {
    stream: TcpStream,
    buf: Vec<u8>,
}

fn connect(addr: SocketAddr) -> Result<Conn> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match TcpStream::connect(addr) {
            Ok(stream) => {
                stream.set_nodelay(true)?;
                return Ok(Conn {
                    stream,
                    buf: Vec::with_capacity(1 << 16),
                });
            }
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e).context("the daemon never listened"),
        }
    }
}

impl Conn {
    /// The body of a GET, which must answer 200 with a length.
    fn get(&mut self, path: &str) -> Result<Vec<u8>> {
        write!(
            self.stream,
            "GET {path} HTTP/1.1\r\nhost: bench\r\nauthorization: Bearer bench\r\n\r\n"
        )?;
        self.buf.clear();
        let mut chunk = [0u8; 1 << 16];
        let head = loop {
            let n = self.stream.read(&mut chunk)?;
            if n == 0 {
                bail!("the daemon hung up");
            }
            self.buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let text = String::from_utf8_lossy(&self.buf[..head]).to_ascii_lowercase();
        if !text.starts_with("http/1.1 200") {
            bail!("{path}: {}", text.lines().next().unwrap_or_default());
        }
        let len: usize = text
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .context("no content-length")?
            .trim()
            .parse()?;
        while self.buf.len() < head + len {
            let n = self.stream.read(&mut chunk)?;
            if n == 0 {
                bail!("the daemon hung up");
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
        Ok(self.buf[head..head + len].to_vec())
    }
}
