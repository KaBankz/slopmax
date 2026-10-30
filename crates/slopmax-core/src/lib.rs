//! slopmax's engine: connected accounts and signing in, the pool that picks
//! an account for each request, the proxy agents talk to, and everything
//! the CLI and the desktop app do alike. Neither front end reimplements
//! what is here; each only asks and shows.
//!
//! The crates beneath it are re-exported under the names the modules here
//! use, so a front end needs this crate alone.

pub mod account;
pub mod agent;
pub mod auth;
pub mod background;
pub mod config;
pub mod daemon;
pub mod doctor;
pub mod fsx;
pub mod history;
pub mod import;
pub mod ledger;
pub mod limits;
pub mod notify;
pub mod paths;
pub mod pool;
pub mod pricing;
pub mod provider;
pub mod proxy;
pub mod report;
pub mod route;
pub mod service;
pub mod summary;
#[cfg(test)]
mod testkit;
pub mod usage;
pub mod waste;

pub use slopmax_common::{human, ids, log, time};
pub use slopmax_net as net;
pub use slopmax_wire as wire;
