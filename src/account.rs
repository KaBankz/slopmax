//! Connected accounts and their on-disk store.
//!
//! Each account lives in its own JSON file under `~/.slopmax/accounts/`,
//! written atomically with owner-only permissions. Files are keyed by a hash
//! of the provider-side identity (Claude organization, ChatGPT workspace), so
//! one email in two organizations stays two accounts with separate limits.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::log;
use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, ids, paths};

/// OAuth tokens for one account.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Codex only: carries the email, plan, and workspace claims.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refreshed_at: Option<Timestamp>,
}

impl Tokens {
    /// True once the access token is within `lead` of expiring.
    pub fn expires_within(&self, lead: SignedDuration, now: Timestamp) -> bool {
        self.expires_at
            .is_some_and(|at| at.duration_since(now) <= lead)
    }

    pub fn is_expired(&self, now: Timestamp) -> bool {
        self.expires_within(SignedDuration::ZERO, now)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    /// Stable handle, e.g. `claude-1a2b3c4d`.
    pub id: String,
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Subscription tier as reported by the provider (`max`, `pro`, `plus`...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Claude account UUID, or the ChatGPT workspace id sent as
    /// `chatgpt-account-id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Claude organization UUID; limits are tracked per organization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    /// Excluded from routing, but its tokens are still kept fresh.
    #[serde(default)]
    pub disabled: bool,
    /// Higher priorities are preferred; ties fall back to the strategy.
    #[serde(default)]
    pub priority: i32,
    /// Set when the refresh token is rejected; cleared by a new login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_error: Option<String>,
    pub tokens: Tokens,
    /// Another tool still refreshes these tokens; slopmax follows its file
    /// instead of refreshing (see `slopmax own`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<Link>,
    pub added_at: Timestamp,
}

/// Where a linked account's tokens come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// The tool that owns them: `cliproxyapi`.
    pub tool: String,
    /// The file it keeps them in.
    pub path: PathBuf,
}

impl Account {
    /// Builds an account and derives its id from the provider identity.
    pub fn new(provider: ProviderId, tokens: Tokens) -> Self {
        let mut account = Self {
            id: String::new(),
            provider,
            label: None,
            email: None,
            plan: None,
            account_id: None,
            org_id: None,
            org_name: None,
            disabled: false,
            priority: 0,
            auth_error: None,
            tokens,
            link: None,
            added_at: Timestamp::now(),
        };
        account.assign_id();
        account
    }

    /// The provider-side key that distinguishes accounts with separate limits.
    pub fn identity_key(&self) -> String {
        self.provider
            .get()
            .identity(self)
            .or(self.email.as_deref())
            .map(str::to_owned)
            .unwrap_or_else(|| self.tokens.refresh_token.clone().unwrap_or_default())
    }

    /// Recomputes `id` from the identity; call after identity fields change.
    pub fn assign_id(&mut self) {
        let digest = ids::sha256(self.identity_key().as_bytes());
        let hex: String = digest[..4].iter().map(|b| format!("{b:02x}")).collect();
        self.id = format!("{}-{hex}", self.provider);
    }

    /// Human-friendly name: the label, else email plus organization.
    pub fn name(&self) -> String {
        if let Some(label) = &self.label {
            return label.clone();
        }
        let email = self.email.as_deref().unwrap_or(&self.id);
        match &self.org_name {
            Some(org) if !org.contains(email) => format!("{email} ({org})"),
            _ => email.to_string(),
        }
    }

    /// Keeps user settings from an older record of the same account.
    pub fn inherit_settings(&mut self, old: &Account) {
        self.label = self.label.take().or_else(|| old.label.clone());
        self.disabled = old.disabled;
        self.priority = old.priority;
        self.added_at = old.added_at;
    }
}

/// Directory-backed account storage.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn open() -> Self {
        Self::at(paths::accounts_dir())
    }

    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// All accounts, ordered by provider, then priority, then age.
    pub fn list(&self) -> Result<Vec<Account>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).context("reading accounts directory"),
        };
        let mut accounts = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                match fsx::read_json::<Account>(&path) {
                    Ok(Some(account)) => accounts.push(account),
                    Ok(None) => {}
                    Err(e) => log::warn!("skipping {}: {e}", path.display()),
                }
            }
        }
        accounts.sort_by(|a, b| {
            (a.provider, -a.priority, a.added_at).cmp(&(b.provider, -b.priority, b.added_at))
        });
        Ok(accounts)
    }

    pub fn get(&self, id: &str) -> Result<Option<Account>> {
        fsx::read_json(&self.path(id)).with_context(|| format!("reading account {id}"))
    }

    /// Writes `account` without locking. Callers that are not refreshing a
    /// token should use [`Store::update`] instead, so they cannot overwrite a
    /// token another process just rotated.
    pub fn save(&self, account: &Account) -> Result<()> {
        fsx::write_json(&self.path(&account.id), account)
            .with_context(|| format!("saving account {}", account.id))
    }

    /// Read-modify-write under the account's lock. This blocks while a
    /// refresh holds the lock, so async callers should run it on a blocking
    /// thread.
    pub fn update(&self, id: &str, change: impl FnOnce(&mut Account)) -> Result<Account> {
        let _lock = self.lock(id)?;
        let mut account = self
            .get(id)?
            .with_context(|| format!("account {id} no longer exists"))?;
        change(&mut account);
        self.save(&account)?;
        Ok(account)
    }

    /// Saves a freshly connected account, merging into an existing record of
    /// the same identity. Returns whether the account is new.
    pub fn upsert(&self, mut account: Account) -> Result<(Account, bool)> {
        account.assign_id();
        let _lock = self.lock(&account.id)?;
        let existing = self.get(&account.id)?;
        if let Some(old) = &existing {
            account.inherit_settings(old);
        }
        self.save(&account)?;
        Ok((account, existing.is_none()))
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let lock = self.lock(id)?;
        fs::remove_file(self.path(id)).with_context(|| format!("removing account {id}"))?;
        drop(lock);
        let _ = fs::remove_file(self.lock_path(id));
        Ok(())
    }

    fn lock_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!(".{id}.lock"))
    }

    /// Takes the cross-process lock that serializes token refreshes for `id`.
    pub fn lock(&self, id: &str) -> Result<fs::File> {
        fsx::lock(&self.lock_path(id)).with_context(|| format!("locking account {id}"))
    }

    /// Resolves a user-supplied reference: an id, id prefix, label, email,
    /// or 1-based position in [`Store::list`].
    pub fn find(&self, query: &str) -> Result<Account> {
        let accounts = self.list()?;
        if let Ok(n) = query.parse::<usize>()
            && let Some(account) = n.checked_sub(1).and_then(|i| accounts.get(i))
        {
            return Ok(account.clone());
        }
        let exact: Vec<&Account> = accounts
            .iter()
            .filter(|a| {
                a.id == query
                    || a.label.as_deref() == Some(query)
                    || a.email.as_deref() == Some(query)
            })
            .collect();
        let matches = if exact.is_empty() {
            accounts
                .iter()
                .filter(|a| a.id.starts_with(query))
                .collect()
        } else {
            exact
        };
        match matches.as_slice() {
            [account] => Ok((*account).clone()),
            [] => bail!("no account matches {query:?} (see `slopmax status`)"),
            many => {
                let ids: Vec<&str> = many.iter().map(|a| a.id.as_str()).collect();
                bail!("{query:?} is ambiguous: {}", ids.join(", "))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("slopmax-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Store::at(dir)
    }

    #[test]
    fn ids_hash_the_identity_as_before() {
        // Ids name the account files, so they must never change.
        let mut account = claude("org-1", "me@x.dev");
        account.assign_id();
        assert_eq!(account.id, "claude-c24787a7");
        let mut codex = Account::new(ProviderId::Codex, Tokens::default());
        codex.account_id = Some("ws-9".into());
        codex.assign_id();
        assert_eq!(codex.id, "codex-372c403d");
    }

    fn claude(org: &str, email: &str) -> Account {
        let mut account = Account::new(ProviderId::Claude, Tokens::default());
        account.org_id = Some(org.into());
        account.email = Some(email.into());
        account.assign_id();
        account
    }

    #[test]
    fn same_email_in_two_orgs_are_distinct_accounts() {
        let a = claude("org-a", "me@x.dev");
        let b = claude("org-b", "me@x.dev");
        assert_ne!(a.id, b.id);
        assert!(a.id.starts_with("claude-") && a.id.len() == "claude-".len() + 8);
    }

    #[test]
    fn upsert_merges_settings_on_relogin() {
        let store = temp_store("upsert");
        let mut first = claude("org-a", "me@x.dev");
        first.label = Some("work".into());
        first.priority = 5;
        let (first, created) = store.upsert(first).unwrap();
        assert!(created);

        let mut again = claude("org-a", "me@x.dev");
        again.tokens.access_token = "new".into();
        let (merged, created) = store.upsert(again).unwrap();
        assert!(!created);
        assert_eq!(merged.id, first.id);
        assert_eq!(merged.label.as_deref(), Some("work"));
        assert_eq!(merged.priority, 5);
        assert_eq!(
            store.get(&first.id).unwrap().unwrap().tokens.access_token,
            "new"
        );
        fs::remove_dir_all(store.dir()).unwrap();
    }

    #[test]
    fn find_resolves_ids_labels_emails_and_positions() {
        let store = temp_store("find");
        let mut work = claude("org-a", "me@x.dev");
        work.label = Some("work".into());
        let (work, _) = store.upsert(work).unwrap();
        let (home, _) = store.upsert(claude("org-b", "home@x.dev")).unwrap();

        assert_eq!(store.find("work").unwrap().id, work.id);
        assert_eq!(store.find("home@x.dev").unwrap().id, home.id);
        assert_eq!(store.find(&work.id[..10]).unwrap().id, work.id);
        assert!(store.find("1").is_ok());
        assert!(
            store.find("claude-").is_err(),
            "prefix shared by both is ambiguous"
        );
        assert!(store.find("nope").is_err());
        fs::remove_dir_all(store.dir()).unwrap();
    }

    #[test]
    fn expiry_checks_respect_lead() {
        let now = Timestamp::from_second(10_000).unwrap();
        let tokens = Tokens {
            expires_at: Some(Timestamp::from_second(10_000 + 1800).unwrap()),
            ..Tokens::default()
        };
        assert!(tokens.expires_within(SignedDuration::from_hours(1), now));
        assert!(!tokens.is_expired(now));
        assert!(
            !Tokens::default().is_expired(now),
            "unknown expiry is not expired"
        );
    }
}
