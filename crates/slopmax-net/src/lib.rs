//! HTTP plumbing shared by the proxy, OAuth flows, and usage polls.

pub mod body;
pub mod client;
mod dial;
pub mod form;
pub mod headers;
pub mod server;
pub mod ws;

pub use client::{Client, Origins};
pub use dial::reachable;
