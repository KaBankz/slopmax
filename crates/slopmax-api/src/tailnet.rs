//! slopmax on the user's tailnet: who may do what, and how the hub is
//! published (`/slopmax/api/tailnet`).

use serde::{Deserialize, Serialize};

/// What a caller may do, from least to most.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    /// Nothing: no key and no tailnet identity slopmax takes.
    None,
    /// The proxy and the model list: a client key, or a tailnet login in
    /// `[tailscale] users`.
    Use,
    /// Also slopmax's status, usage and history: a tailnet login in
    /// `[tailscale] users`.
    View,
    /// Everything: the owner key, or a machine in `[tailscale] admins`.
    Admin,
}

/// Tailscale on the hub, as its CLI reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TailscaleState {
    /// No `tailscale` CLI here.
    Missing,
    /// The CLI runs, but tailscaled does not answer.
    Down,
    /// Tailscale needs a sign-in.
    SignedOut,
    /// Tailscale is turned off (`tailscale up` turns it on).
    Off,
    /// The tailnet's admin has yet to approve this machine.
    NeedsApproval,
    Running,
    /// A state this slopmax does not know.
    Unknown,
}

/// How tailscaled reaches slopmax on the hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// slopmax's owner-only socket, which tells slopmax who is asking.
    Socket,
    /// A private path on the proxy's TCP port that only Tailscale knows,
    /// which tells slopmax who is asking too.
    Private,
    /// The proxy's TCP port on 127.0.0.1, where only keys work.
    Loopback,
}

/// A machine that may manage slopmax, matched by Tailscale's stable node
/// id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminMachine {
    /// Its name on the tailnet: the first label of its DNS name.
    pub machine: String,
    /// Its stable node id (`nXXXXCNTRL`).
    pub id: String,
}

/// What is wrong with publishing slopmax, and what fixes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub text: String,
    /// A command that fixes it, when one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

/// slopmax on the tailnet, as the hub sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailnetView {
    pub tailscale: TailscaleState,
    /// Where the tailnet reaches slopmax, when it is published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<Transport>,
    /// Whether tailnet logins in `users` are taken without a key.
    pub identity: bool,
    /// The hub's name on the tailnet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Tailnet logins whose machines use slopmax and see its status.
    pub users: Vec<String>,
    /// Machines that may also manage it.
    pub admins: Vec<AdminMachine>,
    /// Whether Tailscale Funnel exposes the port to the internet, which
    /// slopmax refuses.
    pub funnel: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<Problem>,
}

/// Changes to who may use slopmax over the tailnet; what is left out stays
/// as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TailnetPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admins: Option<Vec<AdminMachine>>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn access_reads_and_ranks_as_named() {
        for (access, word) in [
            (Access::None, "none"),
            (Access::Use, "use"),
            (Access::View, "view"),
            (Access::Admin, "admin"),
        ] {
            assert_eq!(serde_json::to_value(access).unwrap(), json!(word));
            assert_eq!(
                serde_json::from_value::<Access>(json!(word)).unwrap(),
                access
            );
        }
        assert!(Access::None < Access::Use && Access::Use < Access::View);
        assert!(Access::View < Access::Admin);
    }

    #[test]
    fn states_and_transports_have_their_wire_names() {
        let words: Vec<_> = [
            TailscaleState::Missing,
            TailscaleState::Down,
            TailscaleState::SignedOut,
            TailscaleState::Off,
            TailscaleState::NeedsApproval,
            TailscaleState::Running,
            TailscaleState::Unknown,
        ]
        .into_iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
        assert_eq!(
            words,
            [
                "missing",
                "down",
                "signedOut",
                "off",
                "needsApproval",
                "running",
                "unknown"
            ]
        );
        assert_eq!(
            serde_json::to_value(Transport::Loopback).unwrap(),
            "loopback"
        );
    }

    #[test]
    fn a_view_round_trips_leaving_out_what_it_lacks() {
        let view = TailnetView {
            tailscale: TailscaleState::Running,
            url: Some("https://hub.example.ts.net:7567".into()),
            transport: Some(Transport::Socket),
            identity: true,
            host: Some("hub".into()),
            users: vec!["you@github".into()],
            admins: vec![AdminMachine {
                machine: "laptop".into(),
                id: "nAbCdEf1CNTRL".into(),
            }],
            funnel: false,
            problem: None,
        };
        let wire = serde_json::to_value(&view).unwrap();
        assert_eq!(
            wire,
            json!({
                "tailscale": "running",
                "url": "https://hub.example.ts.net:7567",
                "transport": "socket",
                "identity": true,
                "host": "hub",
                "users": ["you@github"],
                "admins": [{ "machine": "laptop", "id": "nAbCdEf1CNTRL" }],
                "funnel": false
            })
        );
        assert_eq!(serde_json::from_value::<TailnetView>(wire).unwrap(), view);

        let missing = TailnetView {
            tailscale: TailscaleState::Missing,
            url: None,
            transport: None,
            identity: false,
            host: None,
            users: vec![],
            admins: vec![],
            funnel: false,
            problem: Some(Problem {
                text: "Tailscale isn't installed here".into(),
                fix: None,
            }),
        };
        let wire = serde_json::to_value(&missing).unwrap();
        assert_eq!(
            wire,
            json!({
                "tailscale": "missing",
                "identity": false,
                "users": [],
                "admins": [],
                "funnel": false,
                "problem": { "text": "Tailscale isn't installed here" }
            })
        );
        assert_eq!(
            serde_json::from_value::<TailnetView>(wire).unwrap(),
            missing
        );
    }

    #[test]
    fn patches_name_what_they_change_and_nothing_else() {
        let patch: TailnetPatch =
            serde_json::from_value(json!({ "users": ["you@github"] })).unwrap();
        assert_eq!(patch.users, Some(vec!["you@github".to_owned()]));
        assert_eq!(patch.admins, None);
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({ "users": ["you@github"] })
        );
        let admins = json!({ "admins": [{ "machine": "laptop", "id": "nAbC" }] });
        let patch: TailnetPatch = serde_json::from_value(admins.clone()).unwrap();
        assert_eq!(serde_json::to_value(&patch).unwrap(), admins);
        assert_eq!(
            serde_json::from_value::<TailnetPatch>(json!({})).unwrap(),
            TailnetPatch::default()
        );
        assert!(serde_json::from_value::<TailnetPatch>(json!({ "funnel": true })).is_err());
    }
}
