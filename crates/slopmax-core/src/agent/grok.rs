//! Grok Build, xAI's coding agent (the `grok` CLI).
//!
//! Grok Build sends its model traffic to the CLI chat proxy named by
//! `GROK_CLI_CHAT_PROXY_BASE_URL` (or `[endpoints] cli_chat_proxy_base_url`
//! in `~/.grok/config.toml`), and takes its token from an external auth
//! provider: a command whose output is the token (`GROK_AUTH_PROVIDER_COMMAND`,
//! or `[grok_com_config] auth_provider_command`). Pointed at slopmax, the
//! command is `echo <slopmax key>`, which runs alike under sh, cmd and
//! PowerShell; slopmax puts the account's token in its place, so each
//! SuperGrok account serves Grok Build as if it were signed in.
//!
//! Grok Build keeps the token it was handed for good, even when it is
//! refused. `run` and `env` keep it in a file of slopmax's own
//! (`GROK_AUTH_PATH`, one per slopmax key), so Grok Build's own sign-in in
//! `~/.grok/auth.json` is left alone. `setup` has no such file to point at:
//! the token lands in `~/.grok/auth.json`, and `setup` and `--undo` forget
//! it there, so the next run asks for the key again.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use http::HeaderMap;
use serde_json::{Value, json};
use toml_edit::{DocumentMut, Item, Table, value};

use super::{Agent, shell_quote};
use crate::config::Config;
use crate::fsx;
use crate::import::Found;
use crate::net::Client;
use crate::paths::Home;
use crate::provider::{BoxFuture, ProviderId};
use crate::wire::rawjson::{self, Seg};

pub struct GrokBuild;

/// How Grok Build marks a token an auth provider handed it, in
/// `auth.json`, apart from its own sign-in.
const MINTED: &str = "external";
/// Keys Grok Build would use before an auth provider: unset, so they never
/// reach slopmax in place of its key.
const API_KEY_ENVS: [&str; 2] = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"];

/// What `setup` sets in `config.toml`, as (table, key): where model
/// traffic goes, and the command that hands Grok Build its token.
const SETTINGS: [(&str, &str); 2] = [
    ("endpoints", "cli_chat_proxy_base_url"),
    ("grok_com_config", "auth_provider_command"),
];

/// Where Grok Build sends its model traffic through slopmax.
fn base_url(config: &Config) -> String {
    format!("{}/grok/v1", config.base_url())
}

/// The auth provider command: the key as the whole reply.
fn key_command(key: &str) -> String {
    format!("echo {}", shell_quote(key))
}

fn env(config: &Config, home: &Home) -> Vec<(&'static str, String)> {
    let auth = home.grok_auth(&config.api_key);
    // Grok Build writes the file, but may not make its folder.
    if let Some(dir) = auth.parent() {
        let _ = fs::create_dir_all(dir);
    }
    vec![
        ("GROK_CLI_CHAT_PROXY_BASE_URL", base_url(config)),
        ("GROK_AUTH_PROVIDER_COMMAND", key_command(&config.api_key)),
        ("GROK_AUTH_PROVIDER_LABEL", "slopmax".into()),
        ("GROK_AUTH_PATH", auth.to_string_lossy().into_owned()),
    ]
}

impl Agent for GrokBuild {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn api(&self) -> slopmax_api::AgentId {
        slopmax_api::AgentId::GrokBuild
    }

    fn title(&self) -> &'static str {
        "Grok Build"
    }

    fn provider(&self) -> ProviderId {
        ProviderId::Grok
    }

    /// Grok Build names itself `grok-shell/1.0.77 (linux; x86_64)`; its pager
    /// front end, `grok-pager/…`.
    fn detect(&self, headers: &HeaderMap) -> bool {
        headers
            .get(http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ua| ua.starts_with("grok-shell/") || ua.starts_with("grok-pager/"))
    }

    /// Every model request in a Grok Build session, its title included,
    /// carries the session's conversation group; the session id comes only
    /// once the session starts.
    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String> {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        header("x-grok-conv-group-id")
            .or_else(|| header("x-grok-session-id"))
            .or_else(|| rawjson::find_str(body, &[Seg::Key("prompt_cache_key")]))
    }

    fn command(&self, config: &Config, home: &Home, args: &[String]) -> Command {
        let mut command = Command::new("grok");
        command.envs(env(config, home)).args(args);
        for key in API_KEY_ENVS {
            command.env_remove(key);
        }
        command
    }

    fn env(&self, config: &Config, home: &Home, _exe: &Path) -> String {
        let mut out: String = env(config, home)
            .into_iter()
            .map(|(k, v)| format!("export {k}={}\n", shell_quote(&v)))
            .collect();
        out.push_str(&format!("unset {}\n", API_KEY_ENVS.join(" ")));
        out
    }

    fn config_file(&self, home: &Home) -> PathBuf {
        home.grok().join("config.toml")
    }

    fn setup(&self, config: &Config, file: &Path, saved: &mut Option<Value>) -> Result<()> {
        let mut doc = read_toml(file)?;
        if saved.is_none() {
            let previous: serde_json::Map<String, Value> = SETTINGS
                .iter()
                .map(|(table, key)| {
                    let value = doc
                        .get(table)
                        .and_then(|t| t.get(key))
                        .and_then(Item::as_str);
                    ((*key).to_owned(), json!(value))
                })
                .collect();
            *saved = Some(Value::Object(previous));
        }
        // The config file has no environment of its own, so the command
        // carries the key; the file stays private.
        let values = [base_url(config), key_command(&config.api_key)];
        for ((table, key), new) in SETTINGS.iter().zip(values) {
            let table = doc
                .entry(table)
                .or_insert_with(|| Item::Table(Table::new()))
                .as_table_mut()
                .with_context(|| format!("`{table}` in config.toml is not a table"))?;
            table[*key] = value(new);
        }
        fsx::write_private(file, doc.to_string().as_bytes())?;
        forget_minted(file)
    }

    fn undo(&self, file: &Path, saved: Value) -> Result<()> {
        let mut doc = read_toml(file)?;
        for (table, key) in SETTINGS {
            let Some(settings) = doc.get_mut(table).and_then(Item::as_table_mut) else {
                continue;
            };
            match saved.get(key).and_then(Value::as_str) {
                Some(previous) => settings[key] = value(previous),
                None => {
                    settings.remove(key);
                }
            }
            if settings.is_empty() {
                doc.remove(table);
            }
        }
        fsx::write_private(file, doc.to_string().as_bytes())?;
        forget_minted(file)
    }

    fn setup_note(&self) -> &'static str {
        "Restart Grok Build. If it is signed in to xAI, run `grok logout` first: its own \
         sign-in comes before the auth provider slopmax set. After `--undo`, `grok login` \
         signs it back in."
    }

    /// Grok Build's own sign-in is not imported: SuperGrok accounts are
    /// added with `slopmax login grok`, or imported from CLIProxyAPI.
    fn has_login(&self, _home: &Home) -> bool {
        false
    }

    fn wired_to(&self, home: &Home) -> Option<String> {
        let doc = read_toml(&self.config_file(home)).ok()?;
        let base = doc
            .get("endpoints")?
            .get("cli_chat_proxy_base_url")?
            .as_str()?;
        Some(base.to_owned())
    }

    fn import<'a>(&'a self, _http: &'a Client, _home: &'a Home) -> BoxFuture<'a, Option<Found>> {
        Box::pin(std::future::ready(None))
    }

    /// Grok Build reads its settings and models from the CLI chat proxy,
    /// which only a SuperGrok account reaches; xAI keys are its overflow.
    fn served_by_keys(&self) -> bool {
        false
    }
}

/// Drops the tokens an auth provider handed Grok Build from the
/// `auth.json` beside `config`, keeping its own sign-in: a key handed over
/// before is kept for good, so a new one would never be asked for, and
/// after `--undo` it would go to xAI.
fn forget_minted(config: &Path) -> Result<()> {
    let file = config.with_file_name("auth.json");
    // One Grok Build can't read is left for it to report.
    let Ok(Some(Value::Object(mut entries))) = fsx::read_json::<Value>(&file) else {
        return Ok(());
    };
    let before = entries.len();
    entries.retain(|_, entry| entry.get("auth_mode").and_then(Value::as_str) != Some(MINTED));
    if entries.len() == before {
        return Ok(());
    }
    if entries.is_empty() {
        return Ok(fs::remove_file(&file)?);
    }
    let text = serde_json::to_vec_pretty(&Value::Object(entries))?;
    Ok(fsx::write_private(&file, &text)?)
}

/// Whether Grok Build holds its own xAI sign-in beside `config`, which it
/// uses before any auth provider.
pub(crate) fn signed_in(config: &Path) -> bool {
    let file = config.with_file_name("auth.json");
    matches!(
        fsx::read_json::<Value>(&file),
        Ok(Some(Value::Object(entries))) if entries.values().any(|entry| {
            entry.get("auth_mode").and_then(Value::as_str) != Some(MINTED)
        })
    )
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

#[cfg(test)]
mod tests {
    use http::HeaderValue;

    use super::*;

    fn config() -> Config {
        Config {
            api_key: "sm-test".into(),
            ..Config::default()
        }
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn detects_grok_build_and_its_sessions() {
        let title = headers(&[
            ("user-agent", "grok-shell/1.0.77 (linux; x86_64)"),
            ("x-grok-conv-group-id", "group-1"),
            ("x-grok-session-id", ""),
        ]);
        assert!(GrokBuild.detect(&title));
        assert_eq!(GrokBuild.session(&title, b"{}").as_deref(), Some("group-1"));
        let started = headers(&[
            ("user-agent", "grok-pager/1.0.77"),
            ("x-grok-session-id", "sess-1"),
        ]);
        assert!(GrokBuild.detect(&started));
        assert_eq!(
            GrokBuild.session(&started, b"{}").as_deref(),
            Some("sess-1")
        );
        let body = br#"{"prompt_cache_key":"pck"}"#;
        assert_eq!(
            GrokBuild.session(&HeaderMap::new(), body).as_deref(),
            Some("pck")
        );
        assert!(!GrokBuild.detect(&headers(&[("user-agent", "codex_exec/0.1")])));
        assert!(!GrokBuild.detect(&HeaderMap::new()));
    }

    #[test]
    fn run_and_env_point_grok_build_at_the_proxy_with_its_own_auth_file() {
        let home = Home::sandbox("/home/me");
        let command = GrokBuild.command(&config(), &home, &["-p".into(), "hi".into()]);
        assert_eq!(command.get_program(), "grok");
        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        let get = |key: &str| envs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        assert_eq!(
            get("GROK_CLI_CHAT_PROXY_BASE_URL"),
            Some(Some("http://127.0.0.1:7567/grok/v1".into()))
        );
        assert_eq!(
            get("GROK_AUTH_PROVIDER_COMMAND"),
            Some(Some("echo sm-test".into()))
        );
        assert_eq!(
            get("GROK_AUTH_PATH"),
            Some(Some(
                home.grok_auth("sm-test").to_string_lossy().into_owned()
            ))
        );
        assert_eq!(get("XAI_API_KEY"), Some(None));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-p", "hi"]);
        // Each key signs Grok Build in afresh.
        let auth = home.grok_auth("sm-test");
        assert!(auth.starts_with("/home/me/.slopmax/grok"));
        assert_ne!(auth, home.grok_auth("sm-other"));

        let script = GrokBuild.env(&config(), &home, Path::new("slopmax"));
        assert!(
            script.contains("export GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:7567/grok/v1")
        );
        assert!(script.contains("export GROK_AUTH_PROVIDER_COMMAND='echo sm-test'"));
        assert!(script.contains("unset XAI_API_KEY GROK_CODE_XAI_API_KEY"));
    }

    #[test]
    fn setup_round_trips_and_keeps_other_settings() {
        let dir = crate::testkit::temp_dir("grok-setup");
        let file = dir.join("config.toml");
        fs::write(
            &file,
            "model = \"grok-4.7\"\n\n[endpoints]\ndeployment_key = \"d\"\n",
        )
        .unwrap();
        let mut saved = None;
        GrokBuild.setup(&config(), &file, &mut saved).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains(r#"cli_chat_proxy_base_url = "http://127.0.0.1:7567/grok/v1""#));
        let doc: DocumentMut = text.parse().unwrap();
        assert_eq!(
            doc["grok_com_config"]["auth_provider_command"].as_str(),
            Some("echo sm-test")
        );
        assert!(text.contains(r#"deployment_key = "d""#));
        let home = Home::sandbox(dir.to_path_buf());
        fs::create_dir_all(home.grok()).unwrap();
        fs::copy(&file, home.grok().join("config.toml")).unwrap();
        assert_eq!(
            GrokBuild.wired_to(&home).as_deref(),
            Some("http://127.0.0.1:7567/grok/v1")
        );

        // A second setup keeps the first backup.
        let mut again = saved.clone();
        GrokBuild.setup(&config(), &file, &mut again).unwrap();
        assert_eq!(again, saved);

        GrokBuild.undo(&file, saved.unwrap()).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains("cli_chat_proxy_base_url"));
        assert!(!text.contains("auth_provider_command"));
        assert!(text.contains(r#"model = "grok-4.7""#));
        assert!(text.contains(r#"deployment_key = "d""#));
        assert!(!GrokBuild.has_login(&home));
    }

    #[test]
    fn setup_and_undo_forget_the_key_grok_build_was_handed() {
        let dir = crate::testkit::temp_dir("grok-minted");
        let file = dir.join("config.toml");
        let auth = dir.join("auth.json");
        let minted = json!({ "key": "sm-old", "auth_mode": "external" });
        let own = json!({ "key": "xai-token", "auth_mode": "oauth" });
        fs::write(&auth, json!({ "a::1": minted, "b::2": own }).to_string()).unwrap();
        assert!(signed_in(&file));

        let mut saved = None;
        GrokBuild.setup(&config(), &file, &mut saved).unwrap();
        let left: Value = serde_json::from_slice(&fs::read(&auth).unwrap()).unwrap();
        assert_eq!(left, json!({ "b::2": own }));

        fs::write(&auth, json!({ "a::1": minted }).to_string()).unwrap();
        assert!(!signed_in(&file));
        GrokBuild.undo(&file, saved.unwrap()).unwrap();
        assert!(!auth.exists());
        assert!(!signed_in(&file));

        // A file Grok Build can't read is not slopmax's to fix.
        fs::write(&auth, "not json").unwrap();
        GrokBuild.setup(&config(), &file, &mut None).unwrap();
        assert_eq!(fs::read_to_string(&auth).unwrap(), "not json");
    }

    #[test]
    fn undo_restores_what_setup_replaced_and_drops_an_empty_table() {
        let dir = crate::testkit::temp_dir("grok-undo");
        let file = dir.join("config.toml");
        let mut saved = None;
        GrokBuild.setup(&config(), &file, &mut saved).unwrap();
        GrokBuild.undo(&file, saved.unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap().trim(), "");

        fs::write(
            &file,
            "[grok_com_config]\nauth_provider_command = \"mine\"\n[endpoints]\ncli_chat_proxy_base_url = \"https://p\"\n",
        )
        .unwrap();
        let mut saved = None;
        GrokBuild.setup(&config(), &file, &mut saved).unwrap();
        GrokBuild.undo(&file, saved.unwrap()).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains(r#"auth_provider_command = "mine""#));
        assert!(text.contains(r#"cli_chat_proxy_base_url = "https://p""#));
    }
}
