//! The event stream every front end watches (`GET /events`), so nothing
//! polls. Each event is one server-sent `data:` line of JSON.

use serde::{Deserialize, Serialize};

use crate::ledger::LedgerRecord;
use crate::report::{AccountView, Notice, Report};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Event {
    /// The first event on every connection: the proxy is live, its
    /// version, and the program serving it, so a client can tell a daemon
    /// it started from one it did not.
    Hello {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exe: Option<String>,
    },
    /// The report, at connect and whenever it changes.
    Status { report: Box<Report> },
    /// One per request slopmax answered.
    Request { record: LedgerRecord },
    /// Once per notice; the proxy remembers what it told.
    Notice { notice: Notice },
    /// Sign-in progress, for sign-ins started through the API.
    Login { id: String, event: LoginEvent },
    /// Every 15 seconds, so proxies between keep the stream open.
    Ping {},
}

impl Event {
    /// The event as one server-sent event: `data: <json>` and a blank line.
    pub fn frame(&self) -> Vec<u8> {
        let mut out = b"data: ".to_vec();
        serde_json::to_writer(&mut out, self).expect("events serialize");
        out.extend_from_slice(b"\n\n");
        out
    }
}

/// How a sign-in started through the API is going.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum LoginEvent {
    /// Open this address to sign in; `opened` says the daemon opened it.
    Authorize {
        title: String,
        url: String,
        port: u16,
        opened: bool,
    },
    /// Enter this code at this address, on any device.
    DeviceCode {
        url: String,
        code: String,
    },
    Note {
        text: String,
    },
    Done {
        account: Box<AccountView>,
        #[serde(rename = "isNew")]
        is_new: bool,
    },
    Failed {
        message: String,
    },
}
