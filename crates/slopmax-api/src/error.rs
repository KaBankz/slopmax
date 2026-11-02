//! The API's errors: each a `_tag`ged body with the HTTP status it goes out
//! with.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ApiError {
    /// The owner key was missing or wrong. Client keys reach the proxy,
    /// never slopmax's own API.
    Unauthorized {
        message: String,
    },
    /// Nothing by that name: `no such account`, `no such key`.
    NotFound {
        what: String,
        message: String,
    },
    BadRequest {
        message: String,
    },
    /// The request is fine, but the account or setting is not in a state to
    /// do it.
    Conflict {
        message: String,
    },
    /// A provider refused or failed what slopmax asked of it.
    UpstreamFailed {
        message: String,
    },
    Internal {
        message: String,
    },
}

impl ApiError {
    pub fn unauthorized() -> Self {
        Self::Unauthorized {
            message: "missing or invalid slopmax key; see `slopmax env`".into(),
        }
    }

    /// `no such {what}`.
    pub fn not_found(what: &str) -> Self {
        Self::NotFound {
            what: what.into(),
            message: format!("no such {what}"),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest {
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict {
            message: message.into(),
        }
    }

    pub fn upstream(message: impl Into<String>) -> Self {
        Self::UpstreamFailed {
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
        }
    }

    /// The HTTP status it goes out with.
    pub fn status(&self) -> u16 {
        match self {
            Self::Unauthorized { .. } => 401,
            Self::NotFound { .. } => 404,
            Self::BadRequest { .. } => 400,
            Self::Conflict { .. } => 409,
            Self::UpstreamFailed { .. } => 502,
            Self::Internal { .. } => 500,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Unauthorized { message }
            | Self::NotFound { message, .. }
            | Self::BadRequest { message }
            | Self::Conflict { message }
            | Self::UpstreamFailed { message }
            | Self::Internal { message } => message,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ApiError {}
