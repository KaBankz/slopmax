//! slopmax's engine: connected accounts and signing in, the providers, the
//! pool that picks an account for each request, the ledger and what is read
//! from it, the report, and the files they keep. The daemon
//! (`slopmax-daemon`) serves it; the CLI uses it directly only while no
//! daemon runs, and the apps not at all.
//!
//! The crates beneath it are re-exported under the names the modules here
//! use.

pub mod account;
pub mod agent;
pub mod api;
pub mod auth;
pub mod background;
pub mod blocking;
pub mod config;
pub mod doctor;
pub mod error;
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
pub mod report;
pub mod route;
pub mod service;
pub mod state;
pub mod summary;
#[cfg(test)]
mod testkit;
pub mod usage;
pub mod waste;

pub use slopmax_common::{human, ids, log, time};
pub use slopmax_net as net;
pub use slopmax_wire as wire;
