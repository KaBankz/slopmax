//! slopmax: a lightweight multi-account switcher and proxy for Claude Code
//! and Codex.

pub mod account;
pub mod auth;
pub mod config;
pub mod fsx;
pub mod limits;
pub mod paths;
pub mod pool;
pub mod ui;

/// Installs process-wide defaults. Call once before making HTTP requests.
pub fn init() {
    // reqwest is built without a bundled crypto provider; use ring. A second
    // call (for example from tests) finds it already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
}
