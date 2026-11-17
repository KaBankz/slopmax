//! User configuration, stored as TOML in `~/.slopmax/config.toml`.

use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use toml_edit::DocumentMut;

use crate::error::ConfigError;
use crate::net::client::Proxy;
use crate::pricing::Custom;
use crate::{fsx, ids, notify};

fn read_error(path: &Path) -> impl FnOnce(std::io::Error) -> ConfigError {
    let path = path.to_owned();
    move |source| ConfigError::Read { path, source }
}

fn write_error(path: &Path) -> impl FnOnce(std::io::Error) -> ConfigError {
    let path = path.to_owned();
    move |source| ConfigError::Write { path, source }
}

/// What TOML's errors say, on one line: where, and what is wrong.
trait Located {
    fn message(&self) -> &str;
    fn span(&self) -> Option<std::ops::Range<usize>>;
}

impl Located for toml_edit::de::Error {
    fn message(&self) -> &str {
        toml_edit::de::Error::message(self)
    }
    fn span(&self) -> Option<std::ops::Range<usize>> {
        toml_edit::de::Error::span(self)
    }
}

impl Located for toml_edit::TomlError {
    fn message(&self) -> &str {
        toml_edit::TomlError::message(self)
    }
    fn span(&self) -> Option<std::ops::Range<usize>> {
        toml_edit::TomlError::span(self)
    }
}

/// A config file that does not read as one, naming the line at fault.
fn invalid<'a, E: Located>(path: &'a Path, text: &'a str) -> impl FnOnce(E) -> ConfigError + 'a {
    move |e| {
        let message = e.message().trim().trim_end_matches('.').replace('\n', " ");
        let message = match e.span() {
            Some(span) => {
                let line = text[..span.start.min(text.len())].matches('\n').count() + 1;
                format!("line {line}: {message}")
            }
            None => message,
        };
        ConfigError::Invalid {
            path: path.to_owned(),
            message,
        }
    }
}

/// Default proxy port: "slop" on a phone keypad.
pub const DEFAULT_PORT: u16 = 7567;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Address the proxy listens on.
    pub listen: SocketAddr,
    /// Key agents must present (as a bearer token or `x-api-key`).
    pub api_key: String,
    /// How a new session picks its account.
    pub strategy: Strategy,
    /// Minutes a session stays pinned to its account after its last request.
    pub session_ttl_mins: u64,
    /// Keep each session on the account it started on while that account
    /// can serve, so its prompt cache stays warm. Off, every request is
    /// placed by the strategy. A request can say otherwise with the
    /// `x-slopmax-affinity: on|off` header.
    pub session_affinity: bool,
    /// Minutes between background usage polls per account (0 disables).
    pub poll_mins: u64,
    /// Whether the proxy refreshes OAuth tokens. Disable only while another
    /// tool owns the same refresh tokens.
    pub refresh_tokens: bool,
    /// Redeem a ChatGPT reset credit shortly before it expires, if the
    /// account has usage to reset; otherwise the credit lapses unused.
    pub redeem_expiring_credits: bool,
    /// When every Codex account is spent, redeem a banked reset credit
    /// instead of failing the request.
    pub redeem_when_exhausted: bool,
    /// Relay Codex's WebSockets to ChatGPT's, which starts answers sooner
    /// than HTTP streaming. Off, Codex streams over HTTP.
    pub websockets: bool,
    /// Start an idle ChatGPT account's 5-hour window with one tiny request
    /// once the last one resets, so the next reset comes sooner.
    pub warm_windows: bool,
    /// Let API keys serve a subscription's models once every subscription
    /// account is limited. Off, they serve those models only when asked
    /// for by name (`openai/gpt-6-sol`) or when no subscription exists.
    pub paid_overflow: bool,
    /// Look for a new slopmax release once a day, for `slopmax status` to
    /// tell.
    pub check_updates: bool,
    /// Proxy for requests to providers (`http://…`, `socks5://…`), in place
    /// of HTTPS_PROXY.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// Model names that stand for others: `fast = "gpt-6-sol-mini"`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub aliases: BTreeMap<String, String>,
    /// Models to try, in order, once a model is limited on every account.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub fallbacks: BTreeMap<String, Vec<String>>,
    /// Per-model API prices for `slopmax usage`, beyond the built-in ones.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub prices: BTreeMap<String, Custom>,
    /// What each subscription plan costs a month, as `"claude/ultra" =
    /// 200`, for what unused quota is worth; list prices otherwise.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub plan_prices: BTreeMap<String, f64>,
    /// Where to send notifications, and which.
    #[serde(skip_serializing_if = "notify::Settings::is_empty")]
    pub notify: notify::Settings,
    /// Keys for other machines and tools, each possibly limited to some
    /// models. Only `api_key` reaches slopmax's own API.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<ClientKey>,
    /// Who on the user's tailnet uses slopmax without a key, and which
    /// machines may also manage it. Read by [`Config::from_toml`].
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub tailscale: Option<Tailnet>,
    /// The machine whose slopmax this one uses, instead of running its
    /// own proxy. Read by [`Config::from_toml`].
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub hub: Option<HubLink>,
    /// `[tailscale]` and `[hub]` as serde meets them: passed over, for
    /// [`Config::from_toml`] to read.
    #[doc(hidden)]
    #[serde(rename = "tailscale", skip_serializing)]
    pub tailscale_apart: Apart,
    #[doc(hidden)]
    #[serde(rename = "hub", skip_serializing)]
    pub hub_apart: Apart,
}

/// A table serde passes over, read by hand once serde is done: a derived
/// reader of `[tailscale]` and `[hub]` took several times the code.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Apart;

impl<'de> Deserialize<'de> for Apart {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer
            .deserialize_ignored_any(serde::de::IgnoredAny)
            .map(|_| Apart)
    }
}

/// Why a config's text is not a config.
enum Unreadable {
    /// It is not TOML, or a setting serde reads is wrong.
    Toml(toml_edit::de::Error),
    /// `[tailscale]` or `[hub]` is wrong, said naming the line.
    Table(String),
}

impl Unreadable {
    /// The error for a change that would leave the config so.
    fn rejected(self) -> ConfigError {
        match self {
            Self::Toml(e) => ConfigError::Rejected(format!("invalid setting: {e}")),
            Self::Table(message) => ConfigError::Rejected(message),
        }
    }
}

/// "line N: " for what starts at `span` in `text`, when it is known.
fn line_of(text: &str, span: Option<std::ops::Range<usize>>) -> String {
    match span {
        Some(span) => {
            let line = text[..span.start.min(text.len())].matches('\n').count() + 1;
            format!("line {line}: ")
        }
        None => String::new(),
    }
}

/// `[tailscale]`, read from `item` in the config `text`.
fn read_tailnet(item: &toml_edit::Item, text: &str) -> Result<Tailnet, String> {
    let line = |span| line_of(text, span);
    let table = item.as_table_like().ok_or_else(|| {
        format!(
            "{}[tailscale] is a table of users and admins",
            line(item.span())
        )
    })?;
    let mut tailnet = Tailnet::default();
    for (key, value) in table.iter() {
        match key {
            "users" => {
                let users = value.as_array().ok_or_else(|| {
                    format!(
                        "{}[tailscale] users is a list of tailnet logins, such as [\"you@github\"]",
                        line(value.span())
                    )
                })?;
                for user in users {
                    let login = user.as_str().filter(|user| {
                        !user.is_empty()
                            && user.is_ascii()
                            && user.contains('@')
                            && !user.contains("=?")
                    });
                    let Some(login) = login else {
                        let shown = match user.as_str() {
                            Some(user) => format!("{user:?}"),
                            None => user.to_string().trim().to_owned(),
                        };
                        return Err(format!(
                            "{}[tailscale] users: {shown} is not a tailnet login, such as you@github",
                            line(user.span())
                        ));
                    };
                    tailnet.users.push(login.to_owned());
                }
            }
            "admins" => {
                let admin = |entry: Option<&dyn toml_edit::TableLike>, span| {
                    let field = |name| {
                        entry?
                            .get(name)
                            .and_then(toml_edit::Item::as_str)
                            .filter(|value| !value.trim().is_empty())
                    };
                    let only_those = entry.is_some_and(|entry| {
                        entry.iter().all(|(key, _)| matches!(key, "machine" | "id"))
                    });
                    match (field("machine"), field("id")) {
                        (Some(machine), Some(id)) if only_those => Ok(AdminMachine {
                            machine: machine.to_owned(),
                            id: id.to_owned(),
                        }),
                        _ => Err(format!(
                            "{}[tailscale] admins: each needs a machine and its id, and nothing else; `slopmax tailscale admin add <machine>` fills them in",
                            line(span)
                        )),
                    }
                };
                match value {
                    toml_edit::Item::ArrayOfTables(tables) => {
                        for table in tables {
                            tailnet.admins.push(admin(Some(table), table.span())?);
                        }
                    }
                    toml_edit::Item::Value(toml_edit::Value::Array(list)) => {
                        for entry in list {
                            let table = entry
                                .as_inline_table()
                                .map(|t| t as &dyn toml_edit::TableLike);
                            tailnet.admins.push(admin(table, entry.span())?);
                        }
                    }
                    _ => return Err(admin(None, value.span()).unwrap_err()),
                }
            }
            other => {
                return Err(format!(
                    "{}[tailscale] has no setting {other:?}; it takes users and admins",
                    line(value.span())
                ));
            }
        }
    }
    Ok(tailnet)
}

/// `[hub]`, read from `item` in the config `text`.
fn read_hub(item: &toml_edit::Item, text: &str) -> Result<HubLink, String> {
    let line = |span| line_of(text, span);
    let table = item
        .as_table_like()
        .ok_or_else(|| format!("{}[hub] is a table with the hub's url", line(item.span())))?;
    let (mut url, mut key) = (None, None);
    for (name, value) in table.iter() {
        let Some(given) = value.as_str() else {
            return Err(format!(
                "{}[hub] {name} is text, in quotes",
                line(value.span())
            ));
        };
        match name {
            "url" => url = Some((given, value.span())),
            "key" => key = Some(given.to_owned()),
            other => {
                return Err(format!(
                    "{}[hub] has no setting {other:?}; it takes url and key",
                    line(value.span())
                ));
            }
        }
    }
    let Some((url, span)) = url else {
        return Err(format!("{}[hub] needs the hub's url", line(item.span())));
    };
    let uri = url.parse::<http::Uri>().ok().filter(|uri| {
        matches!(uri.scheme_str(), Some("http" | "https"))
            && uri.host().is_some_and(|h| !h.is_empty())
    });
    let Some(uri) = uri else {
        return Err(format!(
            "{}[hub] url = {url:?} is not a web address; give the whole URL, starting with https://",
            line(span.clone())
        ));
    };
    if uri.scheme_str() == Some("http") && key.is_none() && !is_loopback(&uri) {
        return Err(format!(
            "{}[hub] url must be https unless it is on this machine or [hub] key is set",
            line(span)
        ));
    }
    Ok(HubLink {
        url: url.to_owned(),
        key,
    })
}

/// The token agents send a hub that knows their machine by its tailnet
/// login: a placeholder, since the identity is Tailscale's.
pub const TAILNET_TOKEN: &str = "tailnet";

/// `[tailscale]`: who may use slopmax over the tailnet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Tailnet {
    /// Tailnet logins (`you@github`) whose machines use slopmax without a
    /// key and see its status.
    pub users: Vec<String>,
    /// Machines that may also manage slopmax.
    pub admins: Vec<AdminMachine>,
}

/// A machine that may manage slopmax, matched by Tailscale's stable node
/// id; the name is for people.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdminMachine {
    pub machine: String,
    pub id: String,
}

/// `[hub]`: the slopmax this machine's agents use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HubLink {
    pub url: String,
    /// A client key, for a hub that can't tell this machine by its tailnet
    /// login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// A key a client presents instead of `api_key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientKey {
    pub name: String,
    pub key: String,
    /// The models it may use, as patterns where `*` matches anything; any
    /// model when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
}

impl ClientKey {
    pub fn allows(&self, model: &str) -> bool {
        self.models.is_empty()
            || self
                .models
                .iter()
                .any(|p| crate::provider::matches(p, model))
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)),
            api_key: String::new(),
            strategy: Strategy::default(),
            session_ttl_mins: 60,
            session_affinity: true,
            poll_mins: 5,
            refresh_tokens: true,
            redeem_expiring_credits: false,
            redeem_when_exhausted: false,
            websockets: true,
            warm_windows: false,
            paid_overflow: false,
            check_updates: true,
            proxy: None,
            aliases: BTreeMap::new(),
            fallbacks: BTreeMap::new(),
            prices: BTreeMap::new(),
            plan_prices: BTreeMap::new(),
            notify: notify::Settings::default(),
            keys: Vec::new(),
            tailscale: None,
            hub: None,
            tailscale_apart: Apart,
            hub_apart: Apart,
        }
    }
}

/// Account selection strategy for sessions without an existing pin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Strategy {
    /// Spend the quota that expires first: prefer the account whose usage
    /// window resets soonest, so no capacity is lost to a reset.
    ResetFirst,
    /// Drain accounts in order (priority, then `slopmax account order`), moving on
    /// only when one is limited.
    #[default]
    FillFirst,
    /// Spread sessions across accounts, preferring the least used.
    LeastUsed,
    /// Hand each new session (each request, without affinity) to the next
    /// account in turn.
    RoundRobin,
}

impl Strategy {
    pub const ALL: [Strategy; 4] = [
        Strategy::ResetFirst,
        Strategy::FillFirst,
        Strategy::LeastUsed,
        Strategy::RoundRobin,
    ];

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.to_string() == name)
    }

    /// What it does, in a phrase for people.
    pub fn summary(self) -> &'static str {
        match self {
            Self::ResetFirst => "Spend the quota that resets soonest, so none is lost",
            Self::FillFirst => "Use accounts in order; fail over when one is limited",
            Self::LeastUsed => "Balance load toward the least used account",
            Self::RoundRobin => "Take turns across accounts",
        }
    }
}

impl fmt::Display for Strategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ResetFirst => "reset-first",
            Self::FillFirst => "fill-first",
            Self::LeastUsed => "least-used",
            Self::RoundRobin => "round-robin",
        })
    }
}

impl Config {
    /// Loads the config, creating it (with a fresh API key) on first use.
    /// `SLOPMAX_LISTEN` overrides `listen`, for containers.
    pub fn load(home: &crate::paths::Home) -> Result<Self, ConfigError> {
        let mut config = Self::load_from(&home.config())?;
        if let Ok(listen) = std::env::var("SLOPMAX_LISTEN")
            && !listen.is_empty()
        {
            config.listen = listen.parse().map_err(|_| {
                ConfigError::Rejected(format!("SLOPMAX_LISTEN={listen:?} is not an address"))
            })?;
        }
        Ok(config)
    }

    /// What can be read of a config [`Config::load`] refuses: `listen` and
    /// `api_key`, each where it reads, so the commands that stop or inspect
    /// the proxy still reach it; everything else at its default.
    pub fn salvage(home: &crate::paths::Home) -> Self {
        let mut config = Self::default();
        let text = std::fs::read_to_string(home.config()).unwrap_or_default();
        // Top-level settings come before the first table; each line is
        // read on its own, so one broken line spoils only itself.
        for line in text
            .lines()
            .take_while(|l| !l.trim_start().starts_with('['))
        {
            let Ok(doc) = line.parse::<DocumentMut>() else {
                continue;
            };
            if let Some(listen) = doc.get("listen").and_then(|v| v.as_str())
                && let Ok(listen) = listen.parse()
            {
                config.listen = listen;
            }
            if let Some(key) = doc.get("api_key").and_then(|v| v.as_str()) {
                config.api_key = key.to_owned();
            }
        }
        if let Some(listen) = std::env::var("SLOPMAX_LISTEN")
            .ok()
            .and_then(|l| l.parse().ok())
        {
            config.listen = listen;
        }
        config
    }

    pub fn load_from(path: &Path) -> Result<Self, ConfigError> {
        let read = || -> Result<(Option<String>, Self), ConfigError> {
            let text = match std::fs::read_to_string(path) {
                Ok(text) => Some(text),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(source) => return Err(read_error(path)(source)),
            };
            let config = match &text {
                Some(text) => Self::read(text).map_err(|e| match e {
                    Unreadable::Toml(e) => invalid(path, text)(e),
                    Unreadable::Table(message) => ConfigError::Invalid {
                        path: path.to_owned(),
                        message,
                    },
                })?,
                None => Self::default(),
            };
            config
                .notify
                .check()
                .map_err(|message| ConfigError::Invalid {
                    path: path.to_owned(),
                    message,
                })?;
            Ok((text, config))
        };
        let (text, config) = read()?;
        if !config.api_key.is_empty() {
            return Ok(config);
        }
        // The first run makes the key. Processes started together take
        // turns, and each after the first finds the key already made, so
        // all of them agree on it.
        let lock = path.with_file_name(".config.lock");
        let _held = fsx::lock(&lock).map_err(write_error(&lock))?;
        let (text, mut config) = match read()? {
            (_, made) if !made.api_key.is_empty() => return Ok(made),
            _ => (text, config),
        };
        if config.api_key.is_empty() {
            config.api_key = format!("sm-{}", ids::token());
            let text = match text {
                // Add the key without disturbing the user's comments.
                Some(text) => {
                    let mut doc: DocumentMut = text.parse().map_err(invalid(path, &text))?;
                    doc["api_key"] = toml_edit::value(&config.api_key);
                    doc.to_string()
                }
                None => template(&config.api_key),
            };
            fsx::write_private(path, text.as_bytes()).map_err(write_error(path))?;
        }
        Ok(config)
    }

    /// Adds a client key named `name` to the config at `path`, keeping the
    /// file's comments, and returns the new key.
    pub fn add_key(path: &Path, name: &str, models: &[String]) -> Result<String, ConfigError> {
        let config = Self::load_from(path)?;
        if config.keys.iter().any(|k| k.name == name) {
            return Err(ConfigError::KeyExists(name.to_owned()));
        }
        let key = format!("sm-{}", ids::token());
        let mut doc = Self::document(path)?;
        let mut entry = toml_edit::Table::new();
        entry["name"] = toml_edit::value(name);
        entry["key"] = toml_edit::value(&key);
        if !models.is_empty() {
            let list: toml_edit::Array = models.iter().map(String::as_str).collect();
            entry["models"] = toml_edit::value(list);
        }
        doc.entry("keys")
            .or_insert_with(|| toml_edit::Item::ArrayOfTables(Default::default()))
            .as_array_of_tables_mut()
            .ok_or_else(|| ConfigError::Invalid {
                path: path.to_owned(),
                message: "`keys` is not a list of [[keys]] tables".into(),
            })?
            .push(entry);
        fsx::write_private(path, doc.to_string().as_bytes()).map_err(write_error(path))?;
        Ok(key)
    }

    /// Removes the client key named `name`; returns whether there was one.
    pub fn remove_key(path: &Path, name: &str) -> Result<bool, ConfigError> {
        let mut doc = Self::document(path)?;
        let Some(keys) = doc.get_mut("keys").and_then(|k| k.as_array_of_tables_mut()) else {
            return Ok(false);
        };
        let before = keys.len();
        keys.retain(|table| table.get("name").and_then(|n| n.as_str()) != Some(name));
        if keys.len() == before {
            return Ok(false);
        }
        if keys.is_empty() {
            doc.remove("keys");
        }
        fsx::write_private(path, doc.to_string().as_bytes()).map_err(write_error(path))?;
        Ok(true)
    }

    /// Sets top-level settings in the config at `path`, keeping the file's
    /// comments, and returns the config they make. Nothing is written if
    /// the result is not a valid config.
    pub fn set(path: &Path, values: &[(&str, toml_edit::Value)]) -> Result<Self, ConfigError> {
        let mut doc = match std::fs::read_to_string(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => DocumentMut::new(),
            _ => Self::document(path)?,
        };
        for (key, value) in values {
            let mut value = value.clone();
            // A comment beside the old value stays beside the new one.
            if let Some(old) = doc.get(key).and_then(|item| item.as_value()) {
                *value.decor_mut() = old.decor().clone();
            }
            doc[*key] = toml_edit::Item::Value(value);
        }
        let text = doc.to_string();
        let config = Self::read(&text).map_err(Unreadable::rejected)?;
        fsx::write_private(path, text.as_bytes()).map_err(write_error(path))?;
        Ok(config)
    }

    /// The config `text` holds, as config.toml would; an error says what
    /// is wrong, naming the line.
    pub fn from_toml(text: &str) -> Result<Self, String> {
        Self::read(text).map_err(|e| match e {
            Unreadable::Toml(e) => e.to_string(),
            Unreadable::Table(message) => message,
        })
    }

    /// The config `text` holds: serde reads all but `[tailscale]` and
    /// `[hub]`, which are read by hand from the same text, each value
    /// checked.
    fn read(text: &str) -> Result<Self, Unreadable> {
        let mut config = toml_edit::de::from_str::<Self>(text).map_err(Unreadable::Toml)?;
        // Serde read it, so it parses.
        if let Ok(doc) = toml_edit::Document::parse(text) {
            let tables = doc.as_item();
            if let Some(item) = tables.get("tailscale") {
                config.tailscale = Some(read_tailnet(item, text).map_err(Unreadable::Table)?);
            }
            if let Some(item) = tables.get("hub") {
                config.hub = Some(read_hub(item, text).map_err(Unreadable::Table)?);
            }
        }
        Ok(config)
    }

    /// Writes `[tailscale]` in the config at `path`, keeping the file's
    /// comments, and returns the config it makes. Nothing is written if the
    /// result is not a valid config.
    pub fn set_tailnet(path: &Path, tailnet: &Tailnet) -> Result<Self, ConfigError> {
        let mut doc = Self::document_or_new(path)?;
        let table = Self::table_mut(&mut doc, "tailscale");
        let users: toml_edit::Array = tailnet.users.iter().map(String::as_str).collect();
        let admins: toml_edit::Array = tailnet
            .admins
            .iter()
            .map(|admin| {
                let mut entry = toml_edit::InlineTable::new();
                entry.insert("machine", admin.machine.as_str().into());
                entry.insert("id", admin.id.as_str().into());
                toml_edit::Value::InlineTable(entry)
            })
            .collect();
        Self::put(table, "users", users.into());
        Self::put(table, "admins", admins.into());
        Self::write_checked(path, doc)
    }

    /// Writes `[hub]` in the config at `path`, keeping the file's comments,
    /// or removes it for `None`, and returns the config it makes. Nothing is
    /// written if the result is not a valid config.
    pub fn set_hub(path: &Path, hub: Option<&HubLink>) -> Result<Self, ConfigError> {
        let mut doc = Self::document_or_new(path)?;
        match hub {
            None => {
                doc.remove("hub");
            }
            Some(hub) => {
                let table = Self::table_mut(&mut doc, "hub");
                Self::put(table, "url", hub.url.as_str().into());
                match &hub.key {
                    Some(key) => Self::put(table, "key", key.as_str().into()),
                    None => {
                        table.remove("key");
                    }
                }
            }
        }
        Self::write_checked(path, doc)
    }

    /// The config at `path` to edit, or an empty one when there is none.
    fn document_or_new(path: &Path) -> Result<DocumentMut, ConfigError> {
        match std::fs::read_to_string(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DocumentMut::new()),
            _ => Self::document(path),
        }
    }

    /// The table `name`, made (or made a table again) when it is not one.
    fn table_mut<'a>(doc: &'a mut DocumentMut, name: &str) -> &'a mut toml_edit::Table {
        if !doc.get(name).is_some_and(toml_edit::Item::is_table) {
            doc[name] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        doc[name]
            .as_table_mut()
            .expect("the item was just made a table")
    }

    /// Sets `key` in `table`; a comment beside the old value stays beside
    /// the new one.
    fn put(table: &mut toml_edit::Table, key: &str, mut value: toml_edit::Value) {
        if let Some(old) = table.get(key).and_then(toml_edit::Item::as_value) {
            *value.decor_mut() = old.decor().clone();
        }
        table[key] = toml_edit::Item::Value(value);
    }

    /// Writes `doc` to `path` once it reads as a valid config.
    fn write_checked(path: &Path, doc: DocumentMut) -> Result<Self, ConfigError> {
        let text = doc.to_string();
        let config = Self::read(&text).map_err(Unreadable::rejected)?;
        fsx::write_private(path, text.as_bytes()).map_err(write_error(path))?;
        Ok(config)
    }

    fn document(path: &Path) -> Result<DocumentMut, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(read_error(path))?;
        text.parse().map_err(invalid(path, &text))
    }

    /// The base URL this machine's agents use: the hub's, when it uses one,
    /// else this machine's proxy.
    pub fn agent_base(&self) -> String {
        match &self.hub {
            Some(hub) => hub.url.trim_end_matches('/').to_owned(),
            None => self.base_url(),
        }
    }

    /// The token this machine's agents send: the hub's key, or the
    /// placeholder [`TAILNET_TOKEN`] for a hub that knows this machine by
    /// its tailnet login, else this machine's own `api_key`.
    pub fn agent_token(&self) -> String {
        match &self.hub {
            Some(HubLink { key: Some(key), .. }) => key.clone(),
            Some(_) => TAILNET_TOKEN.to_owned(),
            None => self.api_key.clone(),
        }
    }

    /// The hub this machine uses, if any.
    pub fn hub_url(&self) -> Option<&str> {
        self.hub.as_ref().map(|hub| hub.url.as_str())
    }

    /// The tailnet logins taken without a key.
    pub fn tailnet_users(&self) -> &[String] {
        self.tailscale.as_ref().map_or(&[], |t| &t.users)
    }

    /// Whether the tailnet login `login` is taken without a key, matched
    /// without regard to ASCII case. An encoded word (`=?utf-8?q?…?=`) is
    /// never a login.
    pub fn allows_login(&self, login: &str) -> bool {
        !login.contains("=?")
            && self
                .tailnet_users()
                .iter()
                .any(|user| user.eq_ignore_ascii_case(login))
    }

    /// The stable node ids of the machines that may manage slopmax.
    pub fn admin_ids(&self) -> impl Iterator<Item = &str> {
        self.tailscale
            .iter()
            .flat_map(|t| t.admins.iter().map(|admin| admin.id.as_str()))
    }

    /// Why a command that runs or changes this machine's own proxy does
    /// not, when it uses a hub instead.
    pub fn hub_refusal(&self) -> Option<String> {
        self.hub.as_ref().map(|hub| {
            format!(
                "This machine uses the hub at {} and runs no proxy of its own. `slopmax setup --hub off` goes back to its own accounts.",
                hub.url.trim_end_matches('/')
            )
        })
    }

    /// Base URL agents use to reach the proxy.
    pub fn base_url(&self) -> String {
        let ip = self.listen.ip();
        let host = if ip.is_unspecified() {
            "127.0.0.1".to_string()
        } else if ip.is_ipv6() {
            format!("[{ip}]")
        } else {
            ip.to_string()
        };
        format!("http://{host}:{}", self.listen.port())
    }

    /// Applies the settings that hold for the whole process: the proxy for
    /// requests to providers.
    pub fn apply(&self) -> Result<()> {
        if let Some(proxy) = &self.proxy {
            let proxy = Proxy::parse(proxy).map_err(|e| anyhow::anyhow!("config `proxy`: {e}"))?;
            Proxy::set_default(proxy);
        }
        Ok(())
    }

    /// The dashboard's address. The key travels in the fragment, which
    /// browsers never send to a server.
    pub fn dashboard_url(&self) -> String {
        format!("{}/slopmax/#key={}", self.base_url(), self.api_key)
    }
}

/// Whether `uri` names this machine: `localhost` or a loopback address.
fn is_loopback(uri: &http::Uri) -> bool {
    let Some(host) = uri.host() else {
        return false;
    };
    let ip = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || ip
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The config written on first run: the generated key, then every other
/// setting commented out at its default. (Keys are base64url, so they need
/// no escaping.)
fn template(api_key: &str) -> String {
    format!(
        r#"# slopmax settings. Everything but api_key is optional; the commented
# values are the defaults.

# Key agents present to the proxy, as a bearer token or x-api-key.
api_key = "{api_key}"

# Address the proxy listens on.
# listen = "127.0.0.1:{DEFAULT_PORT}"

# How a new session picks its account:
#   fill-first   use accounts in order, moving on when one is limited
#                (the order `slopmax account order` sets)
#   reset-first  spend the quota that resets soonest, so none is lost
#   least-used   spread sessions over the least used accounts
#   round-robin  hand sessions to each account in turn
# strategy = "fill-first"

# Keep a session on the account it started on while that account can serve,
# so the provider's prompt cache stays warm. Off, every request is placed by
# the strategy (load balancing, at the cost of the cache). A client can
# decide per request with the header `x-slopmax-affinity: on` or `off`.
# session_affinity = true

# Minutes a session stays on its account after its last request.
# session_ttl_mins = 60

# Minutes between usage polls per account (0 turns polling off).
# poll_mins = 5

# Refresh OAuth tokens before they expire. Turn this off only while another
# tool uses the same accounts: every refresh rotates the refresh token.
# refresh_tokens = true

# Redeem a ChatGPT reset credit in its last hours, if the account has usage
# to reset, rather than let it expire unused. Off, slopmax only says so
# (the reset-expiring notice); `slopmax account redeem` spends one by hand.
# redeem_expiring_credits = false

# When every Codex account is spent, redeem a reset credit instead of
# failing the request.
# redeem_when_exhausted = false

# Relay Codex's WebSocket connections to ChatGPT, which starts answers
# sooner than HTTP streaming. `slopmax agent connect codex` turns them on in Codex.
# websockets = true

# ChatGPT starts a 5-hour window at an account's first request. With this
# on, an idle account gets one tiny request as soon as its window resets,
# so its next reset comes sooner when you need it. Claude accounts are
# never warmed.
# warm_windows = false

# Let API keys (`slopmax login openai`, `slopmax login anthropic`) serve a
# subscription's models once every subscription account is limited. Off,
# they serve those models only when asked for by name (`openai/gpt-6-sol`)
# or when you have no such subscription.
# paid_overflow = false

# Look for a new slopmax release once a day (one request to github.com),
# for `slopmax status` to tell. `slopmax update` installs it.
# check_updates = true

# Proxy for requests to providers, instead of HTTPS_PROXY:
#   proxy = "socks5h://127.0.0.1:1080"

# Model names that stand for others, and models to try once one is limited
# on every account. A name may pick a provider or account: "openai/gpt-6-sol".
#   [aliases]
#   fast = "gpt-6-sol-mini"
#   [fallbacks]
#   "gpt-6-sol" = ["openai/gpt-6-sol"]

# Notifications, sent when every account of a kind is limited (so requests
# fail), when it recovers, when an account needs `slopmax login` again, when
# a limit reset would expire unused (with redeem_expiring_credits off), and
# when a week is about to reset with much of its quota unused.
# A webhook gets a JSON POST (with "text" and "content", so Slack and
# Discord show it); a command runs in the shell with SLOPMAX_EVENT,
# SLOPMAX_PROVIDER, SLOPMAX_ACCOUNT, SLOPMAX_UNTIL, and SLOPMAX_MESSAGE set.
# Add "limited" and "available" to events to hear about each account too.
# Check the setup with `slopmax notify`.
#   [notify]
#   webhook = "https://hooks.slack.com/services/..."
#   command = 'notify-send slopmax "$SLOPMAX_MESSAGE"'
#   events = ["exhausted", "recovered", "signed-out", "reset-expiring", "quota-unused"]

# More keys, for other machines and tools, made with `slopmax key add`. A
# key may be limited to some models; only api_key reaches slopmax's own API.
#   [[keys]]
#   name = "laptop"
#   key = "sm-..."
#   models = ["gpt-*"]

# Your other machines over Tailscale, once `slopmax tailscale on` publishes
# slopmax to your tailnet:
#   [tailscale]
#   # Tailnet logins whose machines use slopmax without a key and see its
#   # status. List only your own.
#   users = ["you@github"]
#   # Machines that may also manage slopmax. `slopmax tailscale admin add
#   # <machine>` fills this in.
#   admins = []

# On a machine that uses another machine's slopmax: `slopmax setup --hub
# <machine>` writes this.
#   [hub]
#   url = "https://hub.example.ts.net:7567"

# What each subscription costs a month, for what unused quota is worth.
# List prices are built in (Claude Pro $20, Max 5x $100, Max 20x $200;
# ChatGPT Plus $20, Pro $200); set what you really pay:
#   [plan_prices]
#   "claude/ultra" = 200
#   "codex/pro" = 200

# API prices for `slopmax usage`, in dollars per million tokens. Anthropic's
# and OpenAI's list prices are built in; add models it can't price. Cache reads default
# to a tenth of input, cache writes to 1.25x input. For example:
#   [prices."my-model"]
#   input = 2.0
#   output = 8.0
#   cache_read = 0.5
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slopmax-config-{}", ids::token()));
        dir.join("config.toml")
    }

    #[test]
    fn first_load_writes_the_template_with_a_fresh_key() {
        let path = temp_config();
        let first = Config::load_from(&path).unwrap();
        assert!(first.api_key.starts_with("sm-"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, template(&first.api_key));
        let second = Config::load_from(&path).unwrap();
        assert_eq!(first, second);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_missing_key_is_added_without_rewriting_the_file() {
        let path = temp_config();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mine = "# my setup\nstrategy = \"fill-first\" # drain in order\n";
        std::fs::write(&path, mine).unwrap();
        let config = Config::load_from(&path).unwrap();
        assert_eq!(config.strategy, Strategy::FillFirst);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, format!("{mine}api_key = \"{}\"\n", config.api_key));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn processes_started_together_agree_on_the_key() {
        let dir = std::env::temp_dir().join(format!("slopmax-race-{}", ids::token()));
        let path = dir.join("config.toml");
        let keys: Vec<String> = std::thread::scope(|scope| {
            let runs: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| Config::load_from(&path).unwrap().api_key))
                .collect();
            runs.into_iter().map(|r| r.join().unwrap()).collect()
        });
        assert!(keys.iter().all(|k| *k == keys[0]), "{keys:?}");
        assert_eq!(Config::load_from(&path).unwrap().api_key, keys[0]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn template_lists_every_setting_at_its_default() {
        let expected = Config {
            api_key: "sm-key".into(),
            ..Config::default()
        };
        let text = template("sm-key");
        assert_eq!(toml_edit::de::from_str::<Config>(&text).unwrap(), expected);

        let uncommented: String = text
            .lines()
            .map(|line| match line.strip_prefix("# ") {
                // Settings start the line; indented ones are examples.
                Some(setting) if setting.contains(" = ") && !setting.starts_with(' ') => setting,
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            toml_edit::de::from_str::<Config>(&uncommented).unwrap(),
            expected
        );
        let listed: DocumentMut = uncommented.parse().unwrap();
        let fields: DocumentMut = toml_edit::ser::to_string(&expected)
            .unwrap()
            .parse()
            .unwrap();
        let keys = |doc: &DocumentMut| {
            doc.iter()
                .map(|(key, _)| key.to_owned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(keys(&listed), keys(&fields));
    }

    #[test]
    fn parses_partial_config() {
        let config: Config =
            toml_edit::de::from_str("strategy = \"fill-first\"\nlisten = \"0.0.0.0:9000\"")
                .unwrap();
        assert_eq!(config.strategy, Strategy::FillFirst);
        assert_eq!(config.base_url(), "http://127.0.0.1:9000");
        assert_eq!(config.session_ttl_mins, 60);
    }

    #[test]
    fn parses_custom_prices() {
        let config: Config =
            toml_edit::de::from_str("[prices.\"my-model\"]\ninput = 2.0\noutput = 8\n").unwrap();
        let price = config.prices["my-model"];
        assert_eq!(
            (price.input, price.output, price.cache_read),
            (2.0, 8.0, None)
        );
        assert!(toml_edit::de::from_str::<Config>("[prices.m]\ninput = 1\n").is_err());
    }

    #[test]
    fn client_keys_are_added_and_removed_in_place() {
        let path = temp_config();
        let first = Config::load_from(&path).unwrap();
        let laptop = Config::add_key(&path, "laptop", &["gpt-*".into()]).unwrap();
        let ci = Config::add_key(&path, "ci", &[]).unwrap();
        assert!(Config::add_key(&path, "ci", &[]).is_err());
        let config = Config::load_from(&path).unwrap();
        assert_eq!(config.api_key, first.api_key);
        assert_eq!(config.keys.len(), 2);
        assert_eq!(config.keys[0].key, laptop);
        assert!(config.keys[0].allows("gpt-6-sol") && !config.keys[0].allows("claude-opus-5-5"));
        assert!(config.keys[1].allows("anything"));
        assert_ne!(laptop, ci);
        // The template's comments survive.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# slopmax settings."));
        assert!(Config::remove_key(&path, "laptop").unwrap());
        assert!(!Config::remove_key(&path, "laptop").unwrap());
        assert_eq!(Config::load_from(&path).unwrap().keys.len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn rejects_unknown_keys() {
        assert!(toml_edit::de::from_str::<Config>("lisen = \"x\"").is_err());
        assert_eq!(
            Config::from_toml("[tailscale]\non = true\n").unwrap_err(),
            "line 2: [tailscale] has no setting \"on\"; it takes users and admins"
        );
        assert!(Config::from_toml("[hub]\nurl = \"https://h\"\nport = 1\n").is_err());
        assert!(Config::from_toml("[hub]\nkey = \"sm-x\"\n").is_err());
        assert!(Config::from_toml("[hub]\nurl = 1\n").is_err());
        assert!(Config::from_toml("tailscale = 1\n").is_err());
        assert!(Config::from_toml("[tailscale]\nusers = \"you@github\"\n").is_err());
        assert!(
            Config::from_toml("[tailscale]\nadmins = [{ machine = \"m\", id = \"n\", x = 1 }]\n")
                .is_err()
        );
    }

    /// A config at a fresh path holding `text`.
    fn config_with(text: &str) -> std::path::PathBuf {
        let path = temp_config();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn admin(machine: &str, id: &str) -> AdminMachine {
        AdminMachine {
            machine: machine.into(),
            id: id.into(),
        }
    }

    #[test]
    fn tailscale_and_hub_round_trip() {
        let text = r#"api_key = "sm-key"

[tailscale]
users = ["you@github"]
admins = [{ machine = "laptop", id = "nAbC1CNTRL" }]

[hub]
url = "https://hub.example.ts.net:7567"
key = "sm-client"
"#;
        let path = config_with(text);
        let config = Config::load_from(&path).unwrap();
        let tailnet = Tailnet {
            users: vec!["you@github".into()],
            admins: vec![admin("laptop", "nAbC1CNTRL")],
        };
        let hub = HubLink {
            url: "https://hub.example.ts.net:7567".into(),
            key: Some("sm-client".into()),
        };
        assert_eq!(config.tailscale.as_ref(), Some(&tailnet));
        assert_eq!(config.hub.as_ref(), Some(&hub));
        let again = Config::from_toml(&toml_edit::ser::to_string(&config).unwrap()).unwrap();
        assert_eq!(again, config);
        // Admins as a table each read the same.
        let tables =
            Config::from_toml("[[tailscale.admins]]\nmachine = \"laptop\"\nid = \"nAbC1CNTRL\"\n")
                .unwrap();
        assert_eq!(tables.tailscale.unwrap().admins, tailnet.admins);
        // Either table alone, and empty lists, read too.
        let bare = Config::from_toml("[tailscale]\n").unwrap();
        assert_eq!(bare.tailscale, Some(Tailnet::default()));
        assert_eq!(bare.hub, None);
        // Without them, nothing is written of them.
        let plain = toml_edit::ser::to_string(&Config::default()).unwrap();
        assert!(
            !plain.contains("tailscale") && !plain.contains("hub"),
            "{plain}"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn tailscale_and_hub_are_checked_naming_the_line() {
        let refused = |text: &str| -> String {
            let path = config_with(&format!("api_key = \"sm-key\"\n{text}"));
            let error = Config::load_from(&path).unwrap_err().to_string();
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
            error
        };
        let error = refused("[hub]\nurl = \"hub.example.ts.net\"\n");
        assert!(
            error.contains(
                r#"line 3: [hub] url = "hub.example.ts.net" is not a web address; give the whole URL, starting with https://"#
            ),
            "{error}"
        );
        assert!(refused("[hub]\nurl = \"ftp://hub\"\n").contains("is not a web address"));
        assert!(refused("[hub]\nurl = \"https://\"\n").contains("is not a web address"));
        let error = refused("\n[hub]\nurl = \"http://hub.example.ts.net:7567\"\n");
        assert!(
            error.contains(
                "line 4: [hub] url must be https unless it is on this machine or [hub] key is set"
            ),
            "{error}"
        );
        let error = refused("[tailscale]\nusers = [\"you@github\",\n  \"nobody\"]\n");
        assert!(
            error.contains(
                r#"line 4: [tailscale] users: "nobody" is not a tailnet login, such as you@github"#
            ),
            "{error}"
        );
        for bad in ["", "=?utf-8?q?you?=@github", "yöu@github"] {
            let error = refused(&format!("[tailscale]\nusers = [{bad:?}]\n"));
            assert!(error.contains("is not a tailnet login"), "{bad}: {error}");
        }
        let error = refused("[tailscale]\nadmins = [{ machine = \"laptop\", id = \"\" }]\n");
        assert!(
            error.contains("line 3: [tailscale] admins: each needs a machine and its id"),
            "{error}"
        );
        assert!(
            refused("[tailscale]\nadmins = [{ machine = \" \", id = \"n1\" }]\n")
                .contains("each needs a machine and its id")
        );

        // Plain HTTP is fine on this machine, or with a key.
        for ok in [
            "[hub]\nurl = \"http://127.0.0.1:7567\"\n",
            "[hub]\nurl = \"http://localhost:7567/\"\n",
            "[hub]\nurl = \"http://[::1]:7567\"\n",
            "[hub]\nurl = \"http://192.168.1.20:7567\"\nkey = \"sm-x\"\n",
            "[hub]\nurl = \"https://hub.example.ts.net:7567\"\n",
        ] {
            let path = config_with(&format!("api_key = \"sm-key\"\n{ok}"));
            assert!(Config::load_from(&path).is_ok(), "{ok}");
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn agents_use_the_hub_when_there_is_one() {
        let local = Config {
            api_key: "sm-owner".into(),
            ..Config::default()
        };
        assert_eq!(local.agent_base(), "http://127.0.0.1:7567");
        assert_eq!(local.agent_token(), "sm-owner");
        assert_eq!(local.hub_url(), None);
        assert_eq!(local.hub_refusal(), None);

        let hub = Config {
            hub: Some(HubLink {
                url: "https://hub.example.ts.net:7567/".into(),
                key: None,
            }),
            ..local.clone()
        };
        assert_eq!(hub.agent_base(), "https://hub.example.ts.net:7567");
        assert_eq!(hub.agent_token(), TAILNET_TOKEN);
        assert_eq!(hub.hub_url(), Some("https://hub.example.ts.net:7567/"));
        // The proxy this machine would run stays local.
        assert_eq!(hub.base_url(), "http://127.0.0.1:7567");
        assert_eq!(
            hub.hub_refusal().unwrap(),
            "This machine uses the hub at https://hub.example.ts.net:7567 and runs no proxy of its own. `slopmax setup --hub off` goes back to its own accounts."
        );

        let keyed = Config {
            hub: Some(HubLink {
                url: "https://hub.example.ts.net:7567".into(),
                key: Some("sm-x".into()),
            }),
            ..local
        };
        assert_eq!(keyed.agent_base(), "https://hub.example.ts.net:7567");
        assert_eq!(keyed.agent_token(), "sm-x");
    }

    #[test]
    fn logins_are_matched_without_case_and_never_encoded() {
        let config = Config {
            tailscale: Some(Tailnet {
                users: vec!["You@GitHub".into()],
                admins: vec![admin("laptop", "n1"), admin("desk", "n2")],
            }),
            ..Config::default()
        };
        assert!(config.allows_login("you@github"));
        assert!(config.allows_login("YOU@GITHUB"));
        assert!(!config.allows_login("other@github"));
        assert!(!config.allows_login("=?utf-8?q?You@GitHub?="));
        assert_eq!(config.tailnet_users(), ["You@GitHub"]);
        assert_eq!(config.admin_ids().collect::<Vec<_>>(), ["n1", "n2"]);

        let none = Config::default();
        assert!(none.tailnet_users().is_empty());
        assert!(!none.allows_login("you@github"));
        assert_eq!(none.admin_ids().count(), 0);
    }

    #[test]
    fn tailscale_is_written_in_place_keeping_comments() {
        let path = config_with(
            "# my setup\napi_key = \"sm-key\" # the owner's\n\n[tailscale]\n# only mine\nusers = [\"old@github\"] # me\n",
        );
        let tailnet = Tailnet {
            users: vec!["you@github".into(), "work@github".into()],
            admins: vec![admin("laptop", "nAbC1CNTRL")],
        };
        let config = Config::set_tailnet(&path, &tailnet).unwrap();
        assert_eq!(config.tailscale.as_ref(), Some(&tailnet));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("# my setup\napi_key = \"sm-key\" # the owner's\n"),
            "{text}"
        );
        assert!(
            text.contains("# only mine\nusers = [\"you@github\", \"work@github\"] # me\n"),
            "{text}"
        );
        assert!(
            text.contains(r#"admins = [{ machine = "laptop", id = "nAbC1CNTRL" }]"#),
            "{text}"
        );
        assert_eq!(Config::load_from(&path).unwrap(), config);

        // A fresh table goes at the end, and the template's comments stay.
        let fresh = temp_config();
        let first = Config::load_from(&fresh).unwrap();
        let config = Config::set_tailnet(&fresh, &Tailnet::default()).unwrap();
        assert_eq!(config.api_key, first.api_key);
        assert_eq!(config.tailscale, Some(Tailnet::default()));
        let text = std::fs::read_to_string(&fresh).unwrap();
        assert!(text.starts_with("# slopmax settings."), "{text}");

        // Nothing is written when the result is not a valid config.
        let bad = Tailnet {
            users: vec!["nobody".into()],
            admins: vec![],
        };
        let error = Config::set_tailnet(&path, &bad).unwrap_err().to_string();
        assert!(error.contains("is not a tailnet login"), "{error}");
        assert_eq!(Config::load_from(&path).unwrap().tailscale, Some(tailnet));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        std::fs::remove_dir_all(fresh.parent().unwrap()).unwrap();
    }

    #[test]
    fn the_hub_is_set_and_removed_in_place_keeping_comments() {
        let path = config_with("# my setup\napi_key = \"sm-key\" # the owner's\n");
        let hub = HubLink {
            url: "https://hub.example.ts.net:7567".into(),
            key: Some("sm-client".into()),
        };
        let config = Config::set_hub(&path, Some(&hub)).unwrap();
        assert_eq!(config.hub.as_ref(), Some(&hub));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("# my setup\napi_key = \"sm-key\" # the owner's\n"),
            "{text}"
        );
        assert!(
            text.contains(
                "[hub]\nurl = \"https://hub.example.ts.net:7567\"\nkey = \"sm-client\"\n"
            ),
            "{text}"
        );

        // Setting it again without a key drops the key.
        let tailnet_only = HubLink { key: None, ..hub };
        let config = Config::set_hub(&path, Some(&tailnet_only)).unwrap();
        assert_eq!(config.hub, Some(tailnet_only));
        assert!(
            !std::fs::read_to_string(&path)
                .unwrap()
                .contains("sm-client")
        );

        // Plain HTTP to another machine without a key is refused unwritten.
        let insecure = HubLink {
            url: "http://hub.example.ts.net:7567".into(),
            key: None,
        };
        let error = Config::set_hub(&path, Some(&insecure))
            .unwrap_err()
            .to_string();
        assert!(error.contains("must be https"), "{error}");

        let config = Config::set_hub(&path, None).unwrap();
        assert_eq!(config.hub, None);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "# my setup\napi_key = \"sm-key\" # the owner's\n");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
