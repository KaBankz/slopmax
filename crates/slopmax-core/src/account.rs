//! Connected accounts and their on-disk store.
//!
//! Each account lives in its own JSON file under `~/.slopmax/accounts/`,
//! written atomically with owner-only permissions. Files are keyed by a hash
//! of the provider-side identity (Claude organization, ChatGPT workspace), so
//! one email in two organizations stays two accounts with separate limits.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::error::StoreError;
use crate::log;
use crate::paths::Home;
use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;
use crate::{fsx, ids};

/// OAuth tokens for one account, or its API key as a token that never
/// expires.
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
    /// A compatible endpoint's address and models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<Endpoint>,
    pub added_at: Timestamp,
}

/// An OpenAI- or Anthropic-compatible API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    /// Base URL; the request path is appended: `/chat/completions` and
    /// `/responses` for OpenAI-style APIs (so it usually ends in `/v1`),
    /// `/v1/messages` for Anthropic-style ones.
    pub base_url: String,
    pub dialect: Dialect,
    /// The models it serves, as patterns where `*` matches anything.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
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
            endpoint: None,
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
            .or_else(|| self.email.clone())
            .unwrap_or_else(|| self.tokens.refresh_token.clone().unwrap_or_default())
    }

    /// Recomputes `id` from the identity; call after identity fields change.
    pub fn assign_id(&mut self) {
        let digest = ids::sha256(self.identity_key().as_bytes());
        let hex: String = digest[..4].iter().map(|b| format!("{b:02x}")).collect();
        self.id = format!("{}-{hex}", self.provider);
    }

    /// Human-friendly name: the label, else email plus organization (or
    /// for keys, the endpoint's host or the key's last characters).
    pub fn name(&self) -> String {
        if let Some(label) = &self.label {
            return label.clone();
        }
        if let Some(endpoint) = &self.endpoint {
            let host = endpoint.base_url.split("://").last().unwrap_or_default();
            return host.split('/').next().unwrap_or(host).to_owned();
        }
        if !self.provider.spec().is_subscription() {
            let key = &self.tokens.access_token;
            let tail = key.get(key.len().saturating_sub(4)..).unwrap_or_default();
            return format!("{} key …{tail}", self.provider.spec().title);
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
    /// The accounts in `home`.
    pub fn of(home: &Home) -> Self {
        Self::at(home.accounts())
    }

    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.toml"))
    }

    /// All accounts, ordered by provider, then priority, then age.
    pub fn list(&self) -> Result<Vec<Account>, StoreError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(StoreError::io("listing", "files")(e)),
        };
        let mut accounts = Vec::new();
        for entry in entries {
            let mut path = entry.map_err(StoreError::io("listing", "files"))?.path();
            // An account an earlier version wrote as JSON is read (and
            // rewritten as TOML) once, unless its TOML is already there.
            if path.extension().is_some_and(|ext| ext == "json") {
                path.set_extension("toml");
                if path.exists() {
                    continue;
                }
            }
            if path.extension().is_some_and(|ext| ext == "toml") {
                match fsx::read_toml::<Account>(&path) {
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

    pub fn get(&self, id: &str) -> Result<Option<Account>, StoreError> {
        fsx::read_toml(&self.path(id)).map_err(StoreError::io("reading", id))
    }

    /// Writes `account` without locking. Callers that are not refreshing a
    /// token should use [`Store::update`] instead, so they cannot overwrite a
    /// token another process just rotated.
    pub fn save(&self, account: &Account) -> Result<(), StoreError> {
        fsx::write_toml(&self.path(&account.id), account)
            .map_err(StoreError::io("saving", &account.id))
    }

    /// Read-modify-write under the account's lock. This blocks while a
    /// refresh holds the lock, so async callers should run it on a blocking
    /// thread.
    pub fn update(
        &self,
        id: &str,
        change: impl FnOnce(&mut Account),
    ) -> Result<Account, StoreError> {
        let _lock = self.lock(id)?;
        let mut account = self
            .get(id)?
            .ok_or_else(|| StoreError::Gone(id.to_owned()))?;
        change(&mut account);
        self.save(&account)?;
        Ok(account)
    }

    /// Saves a freshly connected account, merging into an existing record of
    /// the same identity. Returns whether the account is new.
    pub fn upsert(&self, mut account: Account) -> Result<(Account, bool), StoreError> {
        account.assign_id();
        let _lock = self.lock(&account.id)?;
        let existing = self.get(&account.id)?;
        if let Some(old) = &existing {
            account.inherit_settings(old);
        }
        self.save(&account)?;
        Ok((account, existing.is_none()))
    }

    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        let lock = self.lock(id)?;
        fs::remove_file(self.path(id)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => StoreError::Gone(id.to_owned()),
            _ => StoreError::io("removing", id)(e),
        })?;
        let _ = fs::remove_file(self.path(id).with_extension("json"));
        drop(lock);
        let _ = fs::remove_file(self.lock_path(id));
        Ok(())
    }

    fn lock_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!(".{id}.lock"))
    }

    /// Takes the cross-process lock that serializes token refreshes for `id`.
    pub fn lock(&self, id: &str) -> Result<fs::File, StoreError> {
        fsx::lock(&self.lock_path(id)).map_err(StoreError::io("locking", id))
    }

    /// Resolves a user-supplied reference: an id, id prefix, label, email,
    /// or 1-based position in [`Store::list`].
    pub fn find(&self, query: &str) -> Result<Account, StoreError> {
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
            [] => Err(StoreError::NotFound(query.to_owned())),
            many => {
                let ids: Vec<&str> = many.iter().map(|a| a.id.as_str()).collect();
                Err(StoreError::Ambiguous {
                    query: query.to_owned(),
                    ids: ids.into_iter().map(str::to_owned).collect(),
                })
            }
        }
    }
}

/// Makes `account` the first choice for its provider's new sessions, for as
/// long as it has quota. For a home no daemon serves; a running one pins
/// through its API.
pub fn pin(home: &Home, account: &Account) -> Result<()> {
    crate::state::change(home, |state| {
        state.pins.insert(account.provider, account.id.clone());
    })
}

/// Lets slopmax choose every provider's accounts again, while no daemon
/// serves `home`.
pub fn unpin_all(home: &Home) -> Result<()> {
    crate::state::change(home, |state| state.pins.clear())
}

/// Forgets `account`, and its pin with it, while no daemon serves `home`.
pub fn forget(store: &Store, home: &Home, account: &Account) -> Result<()> {
    crate::state::change(home, |state| {
        state.pins.retain(|_, pinned| *pinned != account.id);
    })?;
    Ok(store.remove(&account.id)?)
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
