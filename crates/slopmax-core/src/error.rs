//! The engine's errors at the boundaries where a caller decides what to do
//! with them: an account that is not there, a config that will not take a
//! value, a sign-in that cannot start, a provider that refuses, an address
//! already taken. Each is an enum a caller can match on; the daemon turns
//! each into the API's error in one place (`api.rs`), and the CLI shows its
//! words. Errors that are only reported, never decided on, stay `anyhow`
//! inside the engine.

use std::net::SocketAddr;
use std::path::PathBuf;

/// An account looked for, read or written.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("no account matches {0:?} (see `slopmax status`)")]
    NotFound(String),
    #[error("{query:?} is ambiguous: {}", ids.join(", "))]
    Ambiguous { query: String, ids: Vec<String> },
    /// It was there and is not now: removed while being changed.
    #[error("account {0} no longer exists")]
    Gone(String),
    #[error("{doing} account {id}: {source}")]
    Io {
        doing: &'static str,
        id: String,
        #[source]
        source: std::io::Error,
    },
}

impl StoreError {
    pub(crate) fn io(doing: &'static str, id: &str) -> impl FnOnce(std::io::Error) -> Self {
        let id = id.to_owned();
        move |source| Self::Io { doing, id, source }
    }
}

/// config.toml read, checked, or changed.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("reading {}: {source}", path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid config {}: {message}", path.display())]
    Invalid { path: PathBuf, message: String },
    /// A value the setting does not take, in words for whoever gave it.
    #[error("{0}")]
    Rejected(String),
    #[error("a key named {0:?} already exists")]
    KeyExists(String),
    #[error("writing {}: {source}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// A sign-in that could not finish.
#[derive(Debug, thiserror::Error)]
pub enum LoginError {
    /// Keys and endpoints are added, not signed in to.
    #[error("only claude and codex accounts sign in")]
    NotSubscription,
    #[error("the sign-in was cancelled")]
    Cancelled,
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The provider, the browser or the network: in their words.
    #[error("{0:#}")]
    Failed(anyhow::Error),
}

/// A provider that would not do what was asked: list or redeem limit
/// resets, check a key.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// It answered, and said no.
    #[error("{0}")]
    Refused(String),
    #[error("{0:#}")]
    Failed(anyhow::Error),
}

/// The daemon's address, already taken or not available.
#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error("cannot listen on {addr}: {holder} is using that port")]
    Held { addr: SocketAddr, holder: String },
    #[error("cannot listen on {addr}: {source}")]
    Unavailable {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
}
