//! Heap allocations per request, counted on the proxy's thread alone: a
//! measure that, unlike time, a busy machine cannot move. The proxy runs
//! on a thread of its own, as `slopmax serve` does; the mock and the
//! client run on others and are not counted.

#![allow(unsafe_code)] // A global allocator is unsafe to implement.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::Result;

/// Wraps the system allocator, counting what the proxy's thread asks of it.
pub struct Counting;

static COUNT: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static COUNTED: Cell<bool> = const { Cell::new(false) };
    /// Inside a backtrace being taken, whose own allocations are not traced.
    static TRACING: Cell<bool> = const { Cell::new(false) };
}

/// Whether to take a backtrace of each counted allocation (`ALLOCS_TRACE`).
static TRACE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SITES: std::sync::Mutex<Option<std::collections::HashMap<String, u64>>> =
    std::sync::Mutex::new(None);

// SAFETY: every call goes straight to `System`; counting only adds to
// atomics and reads a const-initialized thread-local, neither of which
// allocates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note(layout.size());
        // SAFETY: the caller upholds `alloc`'s contract.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note(layout.size());
        // SAFETY: as above.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        note(size);
        // SAFETY: as above.
        unsafe { System.realloc(ptr, layout, size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: as above.
        unsafe { System.dealloc(ptr, layout) }
    }
}

fn note(size: usize) {
    if COUNTED.try_with(Cell::get).unwrap_or(false) {
        COUNT.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(size as u64, Ordering::Relaxed);
        if TRACE.load(Ordering::Relaxed) && !TRACING.with(Cell::get) {
            TRACING.with(|t| t.set(true));
            let site = site(&std::backtrace::Backtrace::force_capture().to_string());
            let mut sites = SITES.lock().unwrap_or_else(|p| p.into_inner());
            *sites
                .get_or_insert_with(Default::default)
                .entry(site)
                .or_default() += 1;
            drop(sites);
            TRACING.with(|t| t.set(false));
        }
    }
}

/// Where an allocation came from: the first frame in a crate (not std or
/// the allocator), and the first of slopmax's own frames above it.
fn site(trace: &str) -> String {
    let frames: Vec<&str> = trace
        .lines()
        .filter_map(|l| l.trim().split_once(": ").map(|(_, f)| f))
        .collect();
    let crates = [
        "slopmax", "hyper", "http", "tokio", "bytes", "serde", "rustls", "futures", "want",
    ];
    let in_crate = |f: &&&str| crates.iter().any(|c| f.contains(c)) && !f.contains("bench::allocs");
    let first = frames.iter().find(in_crate).copied().unwrap_or("?");
    // The first of slopmax's frames by path; inlined frames carry short
    // names, so failing that, the first that names slopmax at all.
    let ours = frames
        .iter()
        .find(|f| f.trim_start_matches('<').starts_with("slopmax_"))
        .or_else(|| {
            frames
                .iter()
                .filter(in_crate)
                .find(|f| f.contains("slopmax"))
        })
        .copied()
        .unwrap_or("-");
    let short = |f: &str| f.chars().take(150).collect::<String>();
    format!("{}  ⟵  {}", short(first), short(ours))
}

/// Counts what the current thread allocates from now on.
pub fn count_this_thread() {
    COUNTED.with(|c| c.set(true));
}

/// Allocations and bytes counted so far.
pub fn counted() -> (u64, u64) {
    (COUNT.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed))
}

/// Runs `n` requests of each kind one at a time through a proxy on its own
/// thread, and prints the allocations each took.
pub fn run(n: u64) -> Result<()> {
    let dir = std::env::current_dir()?.join(format!("allocs-{}", std::process::id()));
    super::bodies(&dir.join("bodies"))?;
    let mock_addr: std::net::SocketAddr = "127.0.0.1:9250".parse()?;
    let proxy_addr: std::net::SocketAddr = "127.0.0.1:9251".parse()?;
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ = runtime.block_on(super::upstream(mock_addr));
    });
    let home = dir.join("home");
    let home_text = home.to_string_lossy().into_owned();
    std::thread::spawn(move || {
        count_this_thread();
        let runtime = slopmax_core::daemon::runtime().unwrap();
        let _ = runtime.block_on(super::proxy(
            proxy_addr,
            "http://127.0.0.1:9250",
            &home_text,
        ));
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let client = slopmax_core::net::Client::builder().build();
        let base = format!("http://{proxy_addr}");
        for _ in 0..200 {
            if client.get(format!("{base}/healthz")).send().await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        println!("{:<16} {:>12} {:>14}", "request", "allocs/req", "bytes/req");
        for (name, path, file) in [
            ("claude small", "/v1/messages?beta=true", "claude-small"),
            ("claude 300 KB", "/v1/messages?beta=true", "claude-large"),
            ("codex small", "/codex/responses", "codex-small"),
            ("codex 300 KB", "/codex/responses", "codex-large"),
        ] {
            let body = bytes::Bytes::from(std::fs::read(
                dir.join("bodies").join(format!("{file}.json")),
            )?);
            let send = || async {
                let response = client
                    .post(format!("{base}{path}"))
                    .header("authorization", "Bearer bench")
                    .header("content-type", "application/json")
                    .header("user-agent", "claude-cli/2.1.287 (external, cli)")
                    .header("x-claude-code-session-id", "allocs")
                    .header("session_id", "allocs")
                    .body(body.clone())
                    .send()
                    .await?;
                anyhow::ensure!(
                    response.status().is_success(),
                    "status {}",
                    response.status()
                );
                response.bytes().await?;
                anyhow::Ok(())
            };
            // Warm: connections, caches, the ledger's month file.
            for _ in 0..50 {
                send().await?;
            }
            let (count, bytes) = counted();
            for _ in 0..n {
                send().await?;
            }
            let (count_after, bytes_after) = counted();
            if std::env::var_os("ALLOCS_TRACE").is_some() {
                TRACE.store(true, Ordering::Relaxed);
                for _ in 0..10 {
                    send().await?;
                }
                TRACE.store(false, Ordering::Relaxed);
                let sites = SITES.lock().unwrap().take().unwrap_or_default();
                let mut sites: Vec<_> = sites.into_iter().collect();
                sites.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
                for (site, n) in sites.iter().take(40) {
                    println!("  {:>6.1}  {site}", *n as f64 / 10.0);
                }
            }
            println!(
                "{name:<16} {:>12.1} {:>14.0}",
                (count_after - count) as f64 / n as f64,
                (bytes_after - bytes) as f64 / n as f64
            );
        }
        anyhow::Ok(())
    });
    let _ = std::fs::remove_dir_all(&dir);
    result
}
