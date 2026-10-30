//! Notifications on the desktop for the nudges the core finds: a limit
//! reset about to lapse unredeemed, and a week about to reset with quota
//! to spare. Each nudge is told once, as its key names it, even across a
//! restart of the app: what was told is kept in slopmax's home, beside
//! whether to tell at all. The UI posts each [`Alert`] the system's way.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use slopmax_core::config::Config;
use slopmax_core::notify::{self, Event, Kind, Subject};
use slopmax_core::paths::Home;
use slopmax_core::report::Report;
use slopmax_core::time::Timestamp;

/// What the app keeps about notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Told {
    /// Whether to post them at all.
    pub enabled: bool,
    /// The nudges told, by key, with when each stops mattering, after
    /// which it is forgotten.
    pub keys: BTreeMap<String, Timestamp>,
}

impl Default for Told {
    fn default() -> Self {
        Self {
            enabled: true,
            keys: BTreeMap::new(),
        }
    }
}

impl Told {
    /// Where it is kept.
    pub fn path(home: &Home) -> PathBuf {
        home.dir().join("desktop-notified")
    }

    /// What was kept at `path`, or a fresh start. The file has a line
    /// `enabled = true` or `false`, then a line per nudge told: its key
    /// and, after a tab, the second it stops mattering. A line it cannot
    /// read is skipped.
    pub fn load(path: &Path) -> Self {
        let mut told = Self::default();
        let Ok(text) = std::fs::read_to_string(path) else {
            return told;
        };
        for line in text.lines() {
            if let Some(enabled) = line.strip_prefix("enabled = ") {
                told.enabled = enabled.trim() != "false";
            } else if let Some((key, until)) = line.split_once('\t')
                && let Some(until) = until.trim().parse().ok().and_then(Timestamp::from_second)
            {
                told.keys.insert(key.to_owned(), until);
            }
        }
        told
    }

    /// Keeps it at `path`; a failure only means a nudge may be told again.
    pub fn save(&self, path: &Path) {
        let mut text = format!("enabled = {}\n", self.enabled);
        for (key, until) in &self.keys {
            text.push_str(&format!("{key}\t{}\n", until.as_second()));
        }
        let _ = slopmax_core::fsx::write_private(path, text.as_bytes());
    }

    /// The nudges in `found` not told before, which are now remembered as
    /// told. Those whose moment has passed are forgotten. Returns whether
    /// anything changed, to save, with what is new to tell.
    pub fn fresh(
        &mut self,
        found: Vec<(String, Event)>,
        now: Timestamp,
    ) -> (bool, Vec<(String, Event)>) {
        let before = self.keys.len();
        self.keys.retain(|_, until| *until > now);
        let mut changed = self.keys.len() != before;
        let mut new = Vec::new();
        for (key, event) in found {
            if self.keys.contains_key(&key) {
                continue;
            }
            self.keys.insert(key.clone(), event.until.unwrap_or(now));
            changed = true;
            new.push((key, event));
        }
        (changed, new)
    }
}

/// The nudges `report`'s accounts call for, with their keys.
pub fn nudges(report: &Report, config: &Config, now: Timestamp) -> Vec<(String, Event)> {
    let subjects: Vec<Subject> = report.accounts.iter().map(Subject::of).collect();
    notify::nudges(
        &subjects,
        config.redeem_expiring_credits,
        &config.plan_prices,
        now,
    )
}

/// A notification's title for a nudge.
pub fn title(kind: Kind) -> &'static str {
    match kind {
        Kind::ResetExpiring => "Limit reset expiring",
        Kind::QuotaUnused => "Quota going unused",
        Kind::Exhausted => "Every account is limited",
        Kind::Recovered => "Accounts are back",
        Kind::SignedOut => "Sign in again",
        Kind::Limited => "Account limited",
        Kind::Available => "Account available",
        Kind::Test => "slopmax",
    }
}

/// A nudge's words as a notification shows them: the core's, without the
/// marks that set off a command in a terminal.
pub fn body(event: &Event) -> String {
    event.message.replace('`', "")
}

/// A notification for the UI to post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    /// The nudge's key: a notification posted again under it replaces the
    /// last rather than stacking beside it.
    pub key: String,
    pub title: &'static str,
    pub body: String,
}

impl Alert {
    pub fn of(key: String, event: &Event) -> Self {
        Self {
            key,
            title: title(event.event),
            body: body(event),
        }
    }
}

#[cfg(test)]
mod tests {
    use slopmax_core::provider::ProviderId;
    use slopmax_core::time::SignedDuration;

    use super::*;

    fn event(kind: Kind, until: Timestamp) -> Event {
        Event {
            event: kind,
            provider: Some(ProviderId::Codex),
            account: Some("codex0".to_owned()),
            until: Some(until),
            message: "A limit reset on codex0 expires; redeem it with `slopmax redeem codex0`."
                .to_owned(),
            at: until,
            worth: None,
        }
    }

    #[test]
    fn a_nudge_is_told_once() {
        let now = Timestamp::from_second(1_000_000).unwrap();
        let later = now + SignedDuration::from_hours(18);
        let mut told = Told::default();
        let found = || vec![("reset:a:1".to_owned(), event(Kind::ResetExpiring, later))];

        let (changed, new) = told.fresh(found(), now);
        assert!(changed);
        assert_eq!(new.len(), 1);
        // The next look finds the same nudge: nothing to tell or save.
        let (changed, new) = told.fresh(found(), now + SignedDuration::from_secs(2));
        assert!(!changed && new.is_empty());

        // Another nudge is told beside it.
        let mut more = found();
        more.push(("unused:b:7d:9".to_owned(), event(Kind::QuotaUnused, later)));
        let (_, new) = told.fresh(more, now);
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].0, "unused:b:7d:9");
        assert_eq!(new[0].1.event, Kind::QuotaUnused);
    }

    #[test]
    fn what_was_told_outlasts_a_restart_until_its_moment_passes() {
        let now = Timestamp::from_second(1_000_000).unwrap();
        let later = now + SignedDuration::from_hours(18);
        let dir = std::env::temp_dir().join(format!("slopmax-told-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("told");

        let mut told = Told::default();
        told.fresh(
            vec![("reset:a:1".to_owned(), event(Kind::ResetExpiring, later))],
            now,
        );
        told.enabled = false;
        told.save(&path);

        let mut again = Told::load(&path);
        assert_eq!(again, told);
        let (_, new) = again.fresh(
            vec![("reset:a:1".to_owned(), event(Kind::ResetExpiring, later))],
            now,
        );
        assert!(new.is_empty(), "told before the restart");

        // Once it has passed, it is forgotten, and saved so.
        let (changed, new) = again.fresh(Vec::new(), later + SignedDuration::from_secs(1));
        assert!(changed && new.is_empty());
        assert!(again.keys.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_or_broken_file_starts_afresh_with_notifications_on() {
        let told = Told::load(Path::new("/nonexistent/slopmax/told"));
        assert!(told.enabled && told.keys.is_empty());
        let dir = std::env::temp_dir().join(format!("slopmax-broken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("told");
        std::fs::write(&path, "garbage\nkey\tnot a time\n").unwrap();
        let told = Told::load(&path);
        assert!(told.enabled && told.keys.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_notification_reads_plainly() {
        let now = Timestamp::from_second(1_000_000).unwrap();
        let reset = event(Kind::ResetExpiring, now);
        assert_eq!(title(reset.event), "Limit reset expiring");
        assert_eq!(title(Kind::QuotaUnused), "Quota going unused");
        let alert = Alert::of("reset:a:1".to_owned(), &reset);
        assert_eq!(alert.key, "reset:a:1");
        assert_eq!(alert.title, "Limit reset expiring");
        assert_eq!(
            alert.body,
            "A limit reset on codex0 expires; redeem it with slopmax redeem codex0."
        );
    }
}
