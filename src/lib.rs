//! slopmax: a lightweight multi-account switcher and proxy for Claude Code
//! and Codex.

pub mod account;
pub mod agents;
pub mod auth;
pub mod cli;
pub mod config;
pub mod credits;
pub mod daemon;
pub mod fsx;
pub mod ids;
pub mod limits;
pub mod log;
pub mod net;
pub mod paths;
pub mod pool;
pub mod proxy;
pub mod report;
pub mod time;
pub mod ui;
pub mod upstream;
pub mod usage;

/// Installs process-wide defaults. Call once before making HTTP requests.
pub fn init() {
    // reqwest is built without a bundled crypto provider; use ring. A second
    // call (for example from tests) finds it already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
}
