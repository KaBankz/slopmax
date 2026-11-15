//! Connected accounts and their on-disk store.
//!
//! Each account lives in its own JSON file under `~/.slopmax/accounts/`,
//! written atomically with owner-only permissions. Files are keyed by a hash
//! of the provider-side identity (Claude organization, ChatGPT workspace), so
//! one email in two organizations stays two accounts with separate limits.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::{fmt, fs};

use anyhow::Result;
use http::HeaderValue;
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
    /// Its place within its priority tier, from `slopmax order`: lower goes
    /// first, and accounts without one follow, oldest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
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
    #[serde(skip)]
    values: Values,
}

/// Header values made from an account's fields, each the first time a
/// request needs it, and shared by the requests after. A copy of the
/// account starts without them, and each serves only while it still reads
/// as its field.
#[derive(Default)]
struct Values {
    bearer: OnceLock<HeaderValue>,
    account_id: OnceLock<HeaderValue>,
}

impl Clone for Values {
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl fmt::Debug for Values {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Values")
    }
}

/// `prefix` and `text` as a header value: the one in `slot` while it still
/// reads so, else made, and kept there the first time.
fn value(
    slot: &OnceLock<HeaderValue>,
    prefix: &str,
    text: &str,
    sensitive: bool,
) -> Option<HeaderValue> {
    let made = slot.get();
    let current =
        |v: &&HeaderValue| v.as_bytes().strip_prefix(prefix.as_bytes()) == Some(text.as_bytes());
    if let Some(value) = made.filter(current) {
        return Some(value.clone());
    }
    let mut value = HeaderValue::try_from([prefix, text].concat()).ok()?;
    value.set_sensitive(sensitive);
    // A field changed in place since is rare; its value is made each time.
    if made.is_none() {
        let _ = slot.set(value.clone());
    }
    Some(value)
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
            order: None,
            auth_error: None,
            tokens,
            link: None,
            endpoint: None,
            added_at: Timestamp::now(),
            values: Values::default(),
        };
        account.assign_id();
        account
    }

    /// `Bearer` and the access token, as a header value marked sensitive;
    /// `None` when the token cannot be one. Made once and then shared, so
    /// a request costs a reference count.
    pub fn bearer(&self) -> Option<HeaderValue> {
        let token = &self.tokens.access_token;
        value(&self.values.bearer, "Bearer ", token, true)
    }

    /// [`Account::account_id`] as a header value, made once like
    /// [`Account::bearer`].
    pub fn account_id_value(&self) -> Option<HeaderValue> {
        value(
            &self.values.account_id,
            "",
            self.account_id.as_deref()?,
            false,
        )
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
        self.order = old.order;
        self.added_at = old.added_at;
    }

    /// Where it stands among its provider's accounts: priority first, then
    /// its place from `slopmax order`, then age. Fill-first uses them in
    /// this order.
    pub fn rank(&self) -> (std::cmp::Reverse<i32>, u32, Timestamp) {
        (
            std::cmp::Reverse(self.priority),
            self.order.unwrap_or(u32::MAX),
            self.added_at,
        )
    }
}

/// The places `slopmax order` gives `provider`'s accounts so that `first`
/// lead, in the order given, and the rest follow in their present order:
/// each account's id and its new place, for those it changes. Priorities
/// still come first; `first` must not put an account ahead of one in a
/// higher tier.
pub fn reorder<'a>(accounts: &'a [Account], first: &[&str]) -> Result<Vec<(&'a str, u32)>, String> {
    let mut listed: Vec<&Account> = Vec::new();
    for id in first {
        let account = accounts
            .iter()
            .find(|a| a.id == *id)
            .ok_or_else(|| format!("no account {id}"))?;
        if listed.iter().any(|a| a.id == account.id) {
            return Err(format!("{} is listed twice", account.name()));
        }
        if let Some(other) = listed.first()
            && other.provider != account.provider
        {
            return Err(format!(
                "{} is a {} account and {} a {} one; order one kind at a time",
                other.name(),
                other.provider,
                account.name(),
                account.provider
            ));
        }
        listed.push(account);
    }
    for pair in listed.windows(2) {
        if pair[1].priority > pair[0].priority {
            return Err(format!(
                "{} has priority {}, above {}'s {}, so it is used first whatever the order; \
                 change that with `slopmax priority`",
                pair[1].name(),
                pair[1].priority,
                pair[0].name(),
                pair[0].priority
            ));
        }
    }
    let Some(provider) = listed.first().map(|a| a.provider) else {
        return Ok(Vec::new());
    };
    let mut rest: Vec<&Account> = accounts
        .iter()
        .filter(|a| a.provider == provider && !listed.iter().any(|l| l.id == a.id))
        .collect();
    rest.sort_by_key(|a| a.rank());
    Ok(listed
        .into_iter()
        .chain(rest)
        .zip(1..)
        .filter(|(account, place)| account.order != Some(*place))
        .map(|(account, place)| (account.id.as_str(), place))
        .collect())
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
        accounts.sort_by_key(|a| (a.provider, a.rank()));
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
    fn order_puts_the_accounts_given_first_and_keeps_the_rest_after() {
        let store = temp_store("order");
        let mut made = Vec::new();
        for (i, email) in ["a@x.dev", "b@x.dev", "c@x.dev", "d@x.dev"]
            .iter()
            .enumerate()
        {
            let mut account = claude(&format!("org-{i}"), email);
            account.added_at = Timestamp::from_second(1_000 + i as i64).unwrap();
            store.save(&account).unwrap();
            made.push(account.id);
        }
        let names = |store: &Store| -> Vec<String> {
            store
                .list()
                .unwrap()
                .iter()
                .map(|a| a.email.clone().unwrap())
                .collect()
        };
        assert_eq!(names(&store), ["a@x.dev", "b@x.dev", "c@x.dev", "d@x.dev"]);

        let apply = |first: &[&str]| {
            let accounts = store.list().unwrap();
            let changes = reorder(&accounts, first).unwrap();
            for (id, place) in changes {
                store.update(id, |a| a.order = Some(place)).unwrap();
            }
        };
        apply(&[&made[2], &made[0]]);
        assert_eq!(names(&store), ["c@x.dev", "a@x.dev", "b@x.dev", "d@x.dev"]);
        // The rest keep the order they had, not their age.
        apply(&[&made[3]]);
        assert_eq!(names(&store), ["d@x.dev", "c@x.dev", "a@x.dev", "b@x.dev"]);
        // Nothing to change, nothing written.
        let accounts = store.list().unwrap();
        assert!(reorder(&accounts, &[&made[3]]).unwrap().is_empty());

        // An account added later goes last.
        let mut late = claude("org-9", "e@x.dev");
        late.added_at = Timestamp::from_second(500).unwrap();
        store.save(&late).unwrap();
        assert_eq!(names(&store).last().unwrap(), "e@x.dev");

        // Priority tiers still come first, and the order cannot contradict them.
        store.update(&made[1], |a| a.priority = 1).unwrap();
        assert_eq!(names(&store)[0], "b@x.dev");
        let accounts = store.list().unwrap();
        let wrong = reorder(&accounts, &[&made[0], &made[1]]).unwrap_err();
        assert!(wrong.contains("priority 1"), "{wrong}");
        let twice = reorder(&accounts, &[&made[0], &made[0]]).unwrap_err();
        assert!(twice.contains("listed twice"), "{twice}");
        let _ = fs::remove_dir_all(&store.dir);
    }

    #[test]
    fn header_values_are_made_once_and_follow_the_token() {
        let mut account = claude("org-1", "me@x.dev");
        account.tokens.access_token = "one".into();
        let bearer = account.bearer().unwrap();
        assert_eq!(bearer, "Bearer one");
        assert!(bearer.is_sensitive());
        // The same value, shared.
        let again = account.bearer().unwrap();
        assert_eq!(again.as_bytes().as_ptr(), bearer.as_bytes().as_ptr());
        account.tokens.access_token = "two".into();
        assert_eq!(account.bearer().unwrap(), "Bearer two");
        // A copy makes its own.
        let mut copy = account.clone();
        copy.tokens.access_token = "three".into();
        assert_eq!(copy.bearer().unwrap(), "Bearer three");
        assert_eq!(copy.bearer().unwrap(), "Bearer three");
        assert_eq!(account.account_id_value(), None);
        copy.account_id = Some("ws-1".into());
        assert_eq!(copy.account_id_value().unwrap(), "ws-1");
        account.tokens.access_token = "bad\ntoken".into();
        assert_eq!(account.bearer(), None);
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
