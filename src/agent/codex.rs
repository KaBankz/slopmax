//! Codex, wired through a custom model provider in `~/.codex/config.toml`
//! (or `-c` overrides for a single run).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use http::HeaderMap;
use serde::Deserialize;
use serde_json::{Value, json};
use toml_edit::{DocumentMut, Item, Table, value};

use super::{Agent, shell_quote};
use crate::account::{Account, Tokens};
use crate::auth::jwt;
use crate::config::Config;
use crate::fsx;
use crate::import::Found;
use crate::net::Client;
use crate::paths;
use crate::provider::codex::oauth;
use crate::provider::{BoxFuture, ProviderId};
use crate::proxy::rawjson::{self, Seg};
use crate::time::Timestamp;

pub struct Codex;

/// Model provider id slopmax adds to Codex's config.
const PROVIDER: &str = "slopmax";
/// Env var Codex reads the slopmax key from in `run` mode.
const KEY_ENV: &str = "SLOPMAX_API_KEY";

/// Codex subcommands that run a model session. Each parses its own `-c`
/// flags, and those replace (rather than merge with) root-level ones.
const SESSION_COMMANDS: [&str; 5] = ["exec", "e", "review", "resume", "fork"];

/// `-c` overrides that point Codex at the proxy through a custom provider.
/// Named "OpenAI" so Codex keeps first-party behavior such as remote
/// compaction; `env_key` sends the slopmax key as a bearer token.
fn overrides(config: &Config) -> Vec<String> {
    let base = format!("{}/codex", config.base_url());
    let set = |key: &str, val: &str| ["-c".to_owned(), format!("{key}={}", toml_string(val))];
    let mut args = Vec::new();
    args.extend(set("model_provider", PROVIDER));
    for (key, val) in [
        ("name", "OpenAI"),
        ("base_url", base.as_str()),
        ("wire_api", "responses"),
        ("env_key", KEY_ENV),
    ] {
        args.extend(set(&format!("model_providers.{PROVIDER}.{key}"), val));
    }
    args
}

fn toml_string(s: &str) -> String {
    value(s).to_string().trim().to_owned()
}

/// The full Codex argument list: slopmax's overrides at the same level as
/// any the user passes, so neither set drops the other.
fn argv(config: &Config, args: &[String]) -> Vec<String> {
    let overrides = overrides(config);
    match args.split_first() {
        Some((command, rest)) if SESSION_COMMANDS.contains(&command.as_str()) => {
            std::iter::once(command.clone())
                .chain(overrides)
                .chain(rest.iter().cloned())
                .collect()
        }
        _ => overrides.into_iter().chain(args.iter().cloned()).collect(),
    }
}

impl Agent for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn title(&self) -> &'static str {
        "Codex"
    }

    fn provider(&self) -> ProviderId {
        ProviderId::Codex
    }

    /// Codex's clients name themselves `codex_exec/…`, `codex_cli_rs/…`,
    /// and so on.
    fn detect(&self, headers: &HeaderMap) -> bool {
        headers
            .get(http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ua| ua.starts_with("codex"))
    }

    /// Codex sends the same `session-id` for a whole tree of subagents,
    /// matching its `prompt_cache_key`, so the tree stays on one account.
    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String> {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        header("session-id")
            .or_else(|| header("session_id"))
            .or_else(|| {
                let metadata = header("x-codex-turn-metadata")?;
                rawjson::find_str(metadata.as_bytes(), &[Seg::Key("session_id")])
            })
            .or_else(|| rawjson::find_str(body, &[Seg::Key("prompt_cache_key")]))
    }

    fn command(&self, config: &Config, args: &[String]) -> Command {
        let mut command = Command::new("codex");
        command
            .env(KEY_ENV, &config.api_key)
            .args(argv(config, args));
        command
    }

    /// A shell function that goes through `slopmax run`, which places the
    /// overrides after any session subcommand (see [`argv`]).
    fn env(&self, _config: &Config, exe: &Path) -> String {
        let exe = shell_quote(&exe.to_string_lossy());
        format!("codex() {{ {exe} run codex \"$@\"; }}\n")
    }

    fn config_file(&self) -> PathBuf {
        paths::codex_dir().join("config.toml")
    }

    fn setup(&self, config: &Config, file: &Path, saved: &mut Option<Value>) -> Result<()> {
        let mut doc = read_toml(file)?;
        if saved.is_none() {
            let previous = doc
                .get("model_provider")
                .and_then(Item::as_str)
                .filter(|p| *p != PROVIDER);
            *saved = Some(json!({ "model_provider": previous }));
        }
        doc["model_provider"] = value(PROVIDER);

        let providers = doc
            .entry("model_providers")
            .or_insert_with(|| {
                let mut table = Table::new();
                table.set_implicit(true);
                Item::Table(table)
            })
            .as_table_mut()
            .context("`model_providers` in config.toml is not a table")?;
        let mut table = Table::new();
        table["name"] = value("OpenAI");
        table["base_url"] = value(format!("{}/codex", config.base_url()));
        table["wire_api"] = value("responses");
        table["experimental_bearer_token"] = value(config.api_key.as_str());
        // Keeps the desktop app's account screens when signed in to Codex;
        // requests still carry the slopmax key, which takes precedence.
        let signed_in = file
            .parent()
            .is_some_and(|dir| dir.join("auth.json").exists());
        if signed_in {
            table["requires_openai_auth"] = value(true);
        }
        providers.insert(PROVIDER, Item::Table(table));

        // The file now holds the slopmax key, so it stays private.
        Ok(fsx::write_private(file, doc.to_string().as_bytes())?)
    }

    fn undo(&self, file: &Path, saved: Value) -> Result<()> {
        let mut doc = read_toml(file)?;
        match saved.get("model_provider").and_then(Value::as_str) {
            Some(provider) => doc["model_provider"] = value(provider),
            None => {
                doc.remove("model_provider");
            }
        }
        if let Some(providers) = doc.get_mut("model_providers").and_then(Item::as_table_mut) {
            providers.remove(PROVIDER);
        }
        Ok(fsx::write_private(file, doc.to_string().as_bytes())?)
    }

    fn setup_note(&self) -> &'static str {
        "Restart Codex. Quit and reopen the Codex (ChatGPT) desktop app, which reads \
         the same config."
    }

    fn has_login(&self) -> bool {
        let file = paths::codex_dir().join("auth.json");
        fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<AuthFile>(&text).ok())
            .is_some_and(|auth| auth.tokens.is_some())
    }

    fn wired_to(&self) -> Option<String> {
        let doc = read_toml(&self.config_file()).ok()?;
        let provider = doc.get("model_provider")?.as_str()?;
        let base = doc
            .get("model_providers")
            .and_then(|p| p.get(provider))
            .and_then(|t| t.get("base_url"))
            .and_then(Item::as_str);
        Some(match base {
            Some(base) => format!("{provider} ({base})"),
            None => provider.to_owned(),
        })
    }

    fn import<'a>(&'a self, _http: &'a Client) -> BoxFuture<'a, Option<Found>> {
        let file = paths::codex_dir().join("auth.json");
        let found = file.exists().then(|| Found {
            origin: file.display().to_string(),
            account: account_from(&file),
        });
        Box::pin(std::future::ready(found))
    }
}

fn read_toml(path: &Path) -> Result<DocumentMut> {
    match fs::read_to_string(path) {
        Ok(text) => text
            .parse()
            .with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

#[derive(Debug, Deserialize)]
struct AuthFile {
    tokens: Option<AuthTokens>,
    last_refresh: Option<Timestamp>,
}

#[derive(Debug, Deserialize)]
struct AuthTokens {
    id_token: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
}

/// The Codex CLI's login in `~/.codex/auth.json`.
fn account_from(path: &Path) -> Result<Account> {
    let file: AuthFile = serde_json::from_str(&fs::read_to_string(path)?)
        .with_context(|| format!("reading {}", path.display()))?;
    let Some(tokens) = file.tokens else {
        bail!("not a ChatGPT login (API key or proxy auth)");
    };
    let mut account = Account::new(
        ProviderId::Codex,
        Tokens {
            expires_at: jwt::expiry(&tokens.access_token),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            id_token: tokens.id_token,
            refreshed_at: file.last_refresh,
        },
    );
    oauth::apply_claims(&mut account);
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn config() -> Config {
        Config {
            api_key: "sm-test".into(),
            ..Config::default()
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn overrides_define_a_custom_provider() {
        let args = overrides(&config()).join(" ");
        assert!(args.contains(r#"-c model_provider="slopmax""#), "{args}");
        assert!(args.contains(r#"model_providers.slopmax.base_url="http://127.0.0.1:7567/codex""#));
        assert!(args.contains(r#"model_providers.slopmax.env_key="SLOPMAX_API_KEY""#));
        assert!(args.contains(r#"model_providers.slopmax.name="OpenAI""#));
    }

    #[test]
    fn overrides_sit_at_the_users_level() {
        // Session subcommands take the overrides after the subcommand, next
        // to the user's own `-c` flags.
        let args = argv(&config(), &strings(&["exec", "-c", "model=\"m\"", "hi"]));
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "-c");
        assert!(args[2].starts_with("model_provider="));
        assert_eq!(&args[args.len() - 3..], ["-c", "model=\"m\"", "hi"]);
        // The interactive TUI (optionally with a prompt) takes them at the root.
        let args = argv(&config(), &strings(&["fix the bug"]));
        assert_eq!(args[0], "-c");
        assert_eq!(args.last().unwrap(), "fix the bug");
    }

    #[test]
    fn env_hands_off_to_run() {
        let script = Codex.env(&config(), Path::new("/opt/my tools/slopmax"));
        assert_eq!(
            script,
            "codex() { '/opt/my tools/slopmax' run codex \"$@\"; }\n"
        );
    }

    #[test]
    fn session_prefers_header_then_metadata_then_cache_key() {
        let body = br#"{"prompt_cache_key":"pck"}"#;
        assert_eq!(
            Codex.session(&HeaderMap::new(), body).as_deref(),
            Some("pck")
        );
        let mut meta = HeaderMap::new();
        meta.insert(
            "x-codex-turn-metadata",
            HeaderValue::from_static(r#"{"session_id":"meta","thread_id":"t"}"#),
        );
        assert_eq!(Codex.session(&meta, body).as_deref(), Some("meta"));
        let mut hyphen = HeaderMap::new();
        hyphen.insert("session-id", HeaderValue::from_static("sid"));
        assert_eq!(Codex.session(&hyphen, body).as_deref(), Some("sid"));
    }

    #[test]
    fn imports_the_codex_login() {
        let dir = std::env::temp_dir().join(format!("slopmax-codex-auth-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let id_token = jwt::encode_unsigned(&json!({
            "email": "me@x.dev",
            "https://api.openai.com/auth": { "chatgpt_account_id": "ws-1", "chatgpt_plan_type": "plus" }
        }));
        let access = jwt::encode_unsigned(&json!({ "exp": 1_900_000_000 }));
        let path = dir.join("auth.json");
        let body = json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": { "id_token": id_token, "access_token": access, "refresh_token": "rt", "account_id": "ws-1" },
            "last_refresh": "2026-10-01T00:00:00Z"
        });
        std::fs::write(&path, body.to_string()).unwrap();

        let account = account_from(&path).unwrap();
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert_eq!(
            account.tokens.expires_at.unwrap().as_second(),
            1_900_000_000
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn api_key_logins_are_not_imported() {
        let dir = std::env::temp_dir().join(format!("slopmax-codex-key-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("auth.json");
        std::fs::write(&path, r#"{"OPENAI_API_KEY":"sk-local"}"#).unwrap();
        assert!(account_from(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn setup_round_trips_and_keeps_comments() {
        let dir = std::env::temp_dir().join(format!("slopmax-codex-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.toml");
        let original = "# my config\nmodel_provider = \"cliproxyapi\"\nmodel = \"gpt-6-sol\"\n\n[model_providers.cliproxyapi]\nname = \"cliproxyapi\"\n";
        std::fs::write(&file, original).unwrap();

        let mut saved = None;
        Codex.setup(&config(), &file, &mut saved).unwrap();
        let wired = std::fs::read_to_string(&file).unwrap();
        assert!(wired.starts_with("# my config"), "{wired}");
        assert!(wired.contains(r#"model_provider = "slopmax""#));
        assert!(wired.contains("[model_providers.slopmax]"));
        assert!(wired.contains(r#"base_url = "http://127.0.0.1:7567/codex""#));
        assert!(wired.contains(r#"experimental_bearer_token = "sm-test""#));
        assert!(wired.contains("[model_providers.cliproxyapi]"));
        assert!(
            !wired.contains("requires_openai_auth"),
            "not signed in to Codex"
        );

        // Signed in: the desktop app keeps its account screens.
        std::fs::write(dir.join("auth.json"), "{}").unwrap();
        Codex.setup(&config(), &file, &mut saved).unwrap();
        let wired = std::fs::read_to_string(&file).unwrap();
        assert!(wired.contains("requires_openai_auth = true"));

        Codex.undo(&file, saved.unwrap()).unwrap();
        let restored = std::fs::read_to_string(&file).unwrap();
        assert!(
            restored.contains(r#"model_provider = "cliproxyapi""#),
            "{restored}"
        );
        assert!(!restored.contains("slopmax"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
