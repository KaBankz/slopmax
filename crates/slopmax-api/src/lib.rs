//! slopmax's own API, under `/slopmax/api`: the types the daemon answers
//! with and front ends send, as one contract.
//!
//! The daemon serves it; the CLI, the web UI it serves, the macOS app and
//! the desktop app on Windows and Linux are its clients. These are the API's
//! own types, not the engine's: the engine maps its state into them, so
//! neither the wire nor the files on disk constrain the other.
//!
//! The wire format is the one the TypeScript client (`ts/packages/domain`)
//! decodes: camelCase keys, optional keys left out rather than `null`,
//! tagged unions as `{"_tag": …}`, instants as RFC 3339 text. The fixtures
//! in `contract/` hold Rust, TypeScript and Swift to it; requests are read
//! strictly, refusing keys the API does not know.

pub mod events;
pub mod ledger;
pub mod report;
pub mod requests;
pub mod settings;

mod error;
mod ids;

pub use error::ApiError;
pub use ids::*;

/// Where the API lives on the proxy's address.
pub const PREFIX: &str = "/slopmax/api";

/// Instants on the wire.
pub use slopmax_common::time::Timestamp as Instant;
