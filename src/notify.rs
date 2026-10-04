//! Notifications: a webhook or command told when something needs the
//! user's attention. A watcher compares each account's condition with the
//! one it saw last, so every change is reported exactly once.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::account::Account;
use crate::net::Client;
use crate::pool::AccountState;
use crate::provider::ProviderId;
use crate::time::Timestamp;
use crate::ui;

/// How long a notification command may run before it is killed.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Settings under `[notify]` in config.toml.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    /// Receives each event as a JSON POST.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook: Option<String>,
    /// Run by the shell, with the event in `SLOPMAX_*` variables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The events to send; [`DEFAULT_EVENTS`] when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<Kind>,
}

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// An account hit a usage limit.
    Limited,
    /// A limited account can serve again.
    Available,
    /// Every account of a provider is limited, so its requests fail.
    Exhausted,
    /// A provider that was exhausted can serve again.
    Recovered,
    /// An account's sign-in stopped working and needs `slopmax login`.
    SignedOut,
    /// Sent by `slopmax notify` to check the setup.
    Test,
}

/// Sent unless `events` says otherwise: the ones that need action or
/// explain failing requests. Per-account limits come and go all day.
pub const DEFAULT_EVENTS: &[Kind] = &[Kind::Exhausted, Kind::Recovered, Kind::SignedOut];

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Limited => "limited",
            Self::Available => "available",
            Self::Exhausted => "exhausted",
            Self::Recovered => "recovered",
            Self::SignedOut => "signed-out",
            Self::Test => "test",
        }
    }
}

/// One notification.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Event {
    pub event: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderId>,
    /// The account's display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// When the account or provider is expected back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<Timestamp>,
    pub message: String,
    pub at: Timestamp,
}

impl Event {
    pub fn test(now: Timestamp) -> Self {
        Self {
            event: Kind::Test,
            provider: None,
            account: None,
            until: None,
            message: "slopmax notifications are working.".into(),
            at: now,
        }
    }
}

impl Settings {
    pub fn is_enabled(&self) -> bool {
        self.webhook.is_some() || self.command.is_some()
    }

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn wants(&self, kind: Kind) -> bool {
        let events = if self.events.is_empty() {
            DEFAULT_EVENTS
        } else {
            &self.events
        };
        kind == Kind::Test || events.contains(&kind)
    }

    /// Delivers `event` everywhere it is configured to go, if wanted.
    pub async fn send(&self, http: &Client, event: &Event) -> Result<()> {
        if !self.wants(event.event) {
            return Ok(());
        }
        let mut failures = Vec::new();
        if let Some(url) = &self.webhook
            && let Err(e) = post(http, url, event).await
        {
            failures.push(format!("webhook: {e:#}"));
        }
        if let Some(command) = &self.command
            && let Err(e) = run(command, event).await
        {
            failures.push(format!("command: {e:#}"));
        }
        if !failures.is_empty() {
            bail!("{}", failures.join("; "));
        }
        Ok(())
    }
}

/// POSTs the event as JSON. `text` and `content` repeat the message so
/// Slack- and Discord-style webhooks show it as is.
async fn post(http: &Client, url: &str, event: &Event) -> Result<()> {
    let mut body = serde_json::to_value(event)?;
    body["text"] = event.message.clone().into();
    body["content"] = event.message.clone().into();
    http.post(url)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn run(command: &str, event: &Event) -> Result<()> {
    let mut shell = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C");
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c");
        c
    };
    shell
        .arg(command)
        .env("SLOPMAX_EVENT", event.event.as_str())
        .env(
            "SLOPMAX_PROVIDER",
            event.provider.map_or("", ProviderId::as_str),
        )
        .env("SLOPMAX_ACCOUNT", event.account.as_deref().unwrap_or(""))
        .env(
            "SLOPMAX_UNTIL",
            event.until.map(|t| t.to_string()).unwrap_or_default(),
        )
        .env("SLOPMAX_MESSAGE", &event.message)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, shell.output())
        .await
        .context("timed out")?
        .context("could not start it")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("{}: {}", output.status, stderr.trim());
    }
    Ok(())
}

/// An account's condition, as far as notifications care.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Condition {
    Ready,
    Limited,
    SignedOut,
    /// Disabled by the user: none of our business.
    Off,
}

/// Turns successive looks at the pool into events.
#[derive(Debug, Default)]
pub struct Watcher {
    accounts: HashMap<String, Condition>,
    exhausted: BTreeMap<ProviderId, bool>,
    primed: bool,
}

impl Watcher {
    /// What changed since the previous call. The first call only takes
    /// stock: conditions that predate the proxy are not news.
    pub fn changes(
        &mut self,
        accounts: &[Account],
        state_of: impl Fn(&str) -> AccountState,
        now: Timestamp,
    ) -> Vec<Event> {
        let event = |kind, provider, account: Option<&Account>, until, message| Event {
            event: kind,
            provider: Some(provider),
            account: account.map(Account::name),
            until,
            message,
            at: now,
        };
        let mut events = Vec::new();
        for provider in ProviderId::ALL {
            let mine: Vec<(&Account, Condition, Option<Timestamp>)> = accounts
                .iter()
                .filter(|a| a.provider == provider)
                .map(|a| {
                    let until = state_of(&a.id).limited_until(now);
                    let condition = match () {
                        () if a.disabled => Condition::Off,
                        () if a.auth_error.is_some() => Condition::SignedOut,
                        () if until.is_some() => Condition::Limited,
                        () => Condition::Ready,
                    };
                    (a, condition, until)
                })
                .collect();
            let serving: Vec<_> = mine.iter().filter(|m| m.1 != Condition::Off).collect();
            let exhausted = !serving.is_empty() && serving.iter().all(|m| m.1 != Condition::Ready);
            let was_exhausted = self.exhausted.insert(provider, exhausted).unwrap_or(false);
            let soonest = serving.iter().filter_map(|m| m.2).min();
            let title = provider.spec().title;

            for &(account, condition, until) in &mine {
                let before = self.accounts.insert(account.id.clone(), condition);
                if !self.primed || before.is_none_or(|b| b == condition) {
                    continue;
                }
                let name = account.name();
                match condition {
                    // An exhausted pool is one event, not one per account.
                    Condition::Limited if !exhausted || was_exhausted => events.push(event(
                        Kind::Limited,
                        provider,
                        Some(account),
                        until,
                        format!("{name} hit a usage limit{}.", back(until, now)),
                    )),
                    Condition::Ready if before == Some(Condition::Limited) => events.push(event(
                        Kind::Available,
                        provider,
                        Some(account),
                        None,
                        format!("{name} can serve requests again."),
                    )),
                    Condition::SignedOut => events.push(event(
                        Kind::SignedOut,
                        provider,
                        Some(account),
                        None,
                        format!(
                            "{name} is signed out ({}); run `slopmax login {provider}` to \
                             sign in again.",
                            account.auth_error.as_deref().unwrap_or("unknown reason")
                        ),
                    )),
                    _ => {}
                }
            }
            if !self.primed || exhausted == was_exhausted {
                continue;
            }
            events.push(if exhausted {
                event(
                    Kind::Exhausted,
                    provider,
                    None,
                    soonest,
                    format!(
                        "Every {title} account is limited or signed out, so {title} requests \
                         fail{}.",
                        match soonest {
                            Some(at) => format!(" until {}", when(at, now)),
                            None => String::new(),
                        }
                    ),
                )
            } else {
                event(
                    Kind::Recovered,
                    provider,
                    None,
                    None,
                    format!("{title} requests are being served again."),
                )
            });
        }
        // Forget removed accounts, so a re-added one starts fresh.
        self.accounts
            .retain(|id, _| accounts.iter().any(|a| &a.id == id));
        self.primed = true;
        events
    }
}

fn back(until: Option<Timestamp>, now: Timestamp) -> String {
    until
        .filter(|at| *at > now)
        .map(|at| format!("; back {}", when(at, now)))
        .unwrap_or_default()
}

/// `in 2h05m (14:00)`, in local time.
fn when(at: Timestamp, now: Timestamp) -> String {
    let local = at.local_offset();
    let (hour, minute) = at.time_of_day(local);
    format!("in {} ({hour:02}:{minute:02})", ui::until(at, now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;
    use crate::time::SignedDuration;

    fn account(provider: ProviderId, email: &str) -> Account {
        let mut a = Account::new(provider, Tokens::default());
        a.email = Some(email.into());
        a.assign_id();
        a
    }

    fn limited(until: Timestamp) -> AccountState {
        AccountState {
            blocked_until: Some(until),
            ..AccountState::default()
        }
    }

    #[test]
    fn reports_each_change_once() {
        let now = Timestamp::from_second(1_800_000_000).unwrap();
        let later = now + SignedDuration::from_hours(2);
        let a = account(ProviderId::Claude, "a@x.dev");
        let b = account(ProviderId::Claude, "b@x.dev");
        let accounts = [a.clone(), b.clone()];
        let mut states: HashMap<String, AccountState> = HashMap::new();
        let mut watcher = Watcher::default();
        let mut look = |states: &HashMap<String, AccountState>, accounts: &[Account]| {
            watcher.changes(
                accounts,
                |id| states.get(id).cloned().unwrap_or_default(),
                now,
            )
        };

        // The first look takes stock, even of a limited account.
        states.insert(a.id.clone(), limited(later));
        assert!(look(&states, &accounts).is_empty());
        assert!(look(&states, &accounts).is_empty());

        // The last ready account going down is one event for the provider.
        states.insert(b.id.clone(), limited(later));
        let events = look(&states, &accounts);
        let kinds: Vec<Kind> = events.iter().map(|e| e.event).collect();
        assert_eq!(kinds, [Kind::Exhausted]);
        assert_eq!(events[0].until, Some(later));
        assert!(
            events[0].message.starts_with("Every Claude account"),
            "{}",
            events[0].message
        );
        assert!(look(&states, &accounts).is_empty());

        // One coming back is both its own news and the provider's.
        states.remove(&a.id);
        let kinds: Vec<Kind> = look(&states, &accounts).iter().map(|e| e.event).collect();
        assert_eq!(kinds, [Kind::Available, Kind::Recovered]);

        // A sign-out names the fix.
        let mut signed_out = a.clone();
        signed_out.auth_error = Some("refresh token revoked".into());
        let events = look(&states, &[signed_out, b.clone()]);
        let kinds: Vec<Kind> = events.iter().map(|e| e.event).collect();
        assert_eq!(kinds, [Kind::SignedOut, Kind::Exhausted]);
        assert!(
            events[0].message.contains("slopmax login claude"),
            "{}",
            events[0].message
        );
    }

    #[test]
    fn disabled_accounts_are_ignored() {
        let now = Timestamp::from_second(1_800_000_000).unwrap();
        let a = account(ProviderId::Codex, "a@x.dev");
        let mut off = account(ProviderId::Codex, "b@x.dev");
        off.disabled = true;
        let mut watcher = Watcher::default();
        let ready = |_: &str| AccountState::default();
        assert!(
            watcher
                .changes(&[a.clone(), off.clone()], ready, now)
                .is_empty()
        );
        let limited_id = a.id.clone();
        let blocked = |id: &str| {
            if id == limited_id {
                limited(now + SignedDuration::from_mins(5))
            } else {
                AccountState::default()
            }
        };
        let kinds: Vec<Kind> = watcher
            .changes(&[a, off], blocked, now)
            .iter()
            .map(|e| e.event)
            .collect();
        assert_eq!(kinds, [Kind::Exhausted]);
    }

    #[test]
    fn settings_filter_events() {
        let mut settings = Settings::default();
        assert!(!settings.is_enabled());
        assert!(settings.wants(Kind::Exhausted) && !settings.wants(Kind::Limited));
        settings.events = vec![Kind::Limited];
        assert!(settings.wants(Kind::Limited) && !settings.wants(Kind::Exhausted));
        assert!(settings.wants(Kind::Test));
        let parsed: Settings =
            toml_edit::de::from_str("command = \"true\"\nevents = [\"signed-out\"]").unwrap();
        assert_eq!(parsed.events, [Kind::SignedOut]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn commands_get_the_event_in_variables() {
        let dir = std::env::temp_dir().join(format!("slopmax-notify-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out");
        let settings = Settings {
            command: Some(format!(
                "printf '%s|%s' \"$SLOPMAX_EVENT\" \"$SLOPMAX_MESSAGE\" > '{}'",
                out.display()
            )),
            ..Settings::default()
        };
        let http = Client::builder().build();
        let event = Event::test(Timestamp::now());
        settings.send(&http, &event).await.unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert_eq!(text, "test|slopmax notifications are working.");

        let failing = Settings {
            command: Some("echo nope >&2; exit 3".into()),
            ..Settings::default()
        };
        let error = failing.send(&http, &event).await.unwrap_err().to_string();
        assert!(error.contains("nope"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
