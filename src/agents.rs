//! Connecting Claude Code and Codex to the proxy.
//!
//! Three ways, from least to most invasive:
//! - `slopmax run <agent>` launches the agent wired up for that session;
//! - `slopmax env <agent>` prints shell setup to `eval`;
//! - `slopmax setup <agent>` writes the wiring into the agent's own config
//!   (keeping a backup for `--undo`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use toml_edit::{DocumentMut, Item, Table, value};

use crate::account::Provider;
use crate::config::Config;
use crate::{fsx, paths};

/// Codex model provider id written by slopmax.
const CODEX_PROVIDER: &str = "slopmax";
/// Env var Codex reads the slopmax key from in `run` mode.
const CODEX_KEY_ENV: &str = "SLOPMAX_API_KEY";

/// Environment for Claude Code. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
/// makes these win over provider variables in `~/.claude/settings.json`.
pub fn claude_env(config: &Config) -> Vec<(&'static str, String)> {
    vec![
        ("ANTHROPIC_BASE_URL", config.base_url()),
        ("ANTHROPIC_AUTH_TOKEN", config.api_key.clone()),
        ("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1".into()),
        ("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1".into()),
    ]
}

/// `-c` overrides that point Codex at the proxy through a custom provider.
/// Named "OpenAI" so Codex keeps first-party behavior such as remote
/// compaction; `env_key` sends the slopmax key as a bearer token.
pub fn codex_args(config: &Config) -> Vec<String> {
    let base = format!("{}/codex", config.base_url());
    let set = |key: &str, val: &str| ["-c".to_owned(), format!("{key}={}", toml_string(val))];
    let mut args = Vec::new();
    args.extend(set("model_provider", CODEX_PROVIDER));
    for (key, val) in [
        ("name", "OpenAI"),
        ("base_url", base.as_str()),
        ("wire_api", "responses"),
        ("env_key", CODEX_KEY_ENV),
    ] {
        args.extend(set(&format!("model_providers.{CODEX_PROVIDER}.{key}"), val));
    }
    args
}

fn toml_string(s: &str) -> String {
    value(s).to_string().trim().to_owned()
}

/// Codex subcommands that run a model session. Each parses its own `-c`
/// flags, and those replace (rather than merge with) root-level ones.
const CODEX_SESSION_COMMANDS: [&str; 5] = ["exec", "e", "review", "resume", "fork"];

/// The full Codex argument list: slopmax's overrides at the same level as
/// any the user passes, so neither set drops the other.
pub fn codex_argv(config: &Config, args: &[String]) -> Vec<String> {
    let overrides = codex_args(config);
    match args.split_first() {
        Some((command, rest)) if CODEX_SESSION_COMMANDS.contains(&command.as_str()) => {
            std::iter::once(command.clone())
                .chain(overrides)
                .chain(rest.iter().cloned())
                .collect()
        }
        _ => overrides.into_iter().chain(args.iter().cloned()).collect(),
    }
}

/// Launches the agent through the proxy and returns its exit status.
pub fn run(agent: Provider, config: &Config, args: &[String]) -> Result<i32> {
    let mut command = match agent {
        Provider::Claude => {
            let mut command = Command::new("claude");
            command
                .envs(claude_env(config))
                .env_remove("ANTHROPIC_API_KEY")
                .args(args);
            command
        }
        Provider::Codex => {
            let mut command = Command::new("codex");
            command
                .env(CODEX_KEY_ENV, &config.api_key)
                .args(codex_argv(config, args));
            command
        }
    };
    let program = command.get_program().to_string_lossy().into_owned();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = command.exec();
        bail!("could not start {program}: {err}");
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .with_context(|| format!("could not start {program}"))?;
        Ok(status.code().unwrap_or(1))
    }
}

/// Shell commands that wire the current shell to the proxy. Codex gets a
/// function that goes through `slopmax run` (at `exe`), since its overrides
/// must follow any session subcommand; see [`codex_argv`].
pub fn env_script(agent: Provider, config: &Config, exe: &Path) -> String {
    match agent {
        Provider::Claude => {
            let mut out: String = claude_env(config)
                .into_iter()
                .map(|(k, v)| format!("export {k}={}\n", shell_quote(&v)))
                .collect();
            out.push_str("unset ANTHROPIC_API_KEY\n");
            out
        }
        Provider::Codex => {
            let exe = shell_quote(&exe.to_string_lossy());
            format!("codex() {{ {exe} run codex \"$@\"; }}\n")
        }
    }
}

fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:=@".contains(c))
    {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// What `setup` replaced, so `--undo` can put it back.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Backup {
    /// Claude Code `settings.json` env values (null = absent).
    #[serde(default)]
    claude_env: Option<BTreeMap<String, Value>>,
    /// Codex root `model_provider` value before setup (None = absent).
    #[serde(default)]
    codex_model_provider: Option<Option<String>>,
}

impl Backup {
    fn load(path: &Path) -> Result<Self> {
        Ok(fsx::read_json(path)?.unwrap_or_default())
    }

    fn save(&self, path: &Path) -> Result<()> {
        Ok(fsx::write_json(path, self)?)
    }
}

/// The agent config file `setup` edits.
pub fn config_path(agent: Provider) -> PathBuf {
    match agent {
        Provider::Claude => paths::claude_dir().join("settings.json"),
        Provider::Codex => paths::codex_dir().join("config.toml"),
    }
}

fn backup_path() -> PathBuf {
    paths::home().join("setup-backup.json")
}

/// Persists the wiring in the agent's config. Returns the file changed.
pub fn setup(agent: Provider, config: &Config) -> Result<PathBuf> {
    let path = config_path(agent);
    match agent {
        Provider::Claude => setup_claude(config, &path, &backup_path())?,
        Provider::Codex => setup_codex(config, &path, &backup_path())?,
    }
    Ok(path)
}

/// Reverts `setup`. Returns the file changed.
pub fn undo(agent: Provider) -> Result<PathBuf> {
    let path = config_path(agent);
    match agent {
        Provider::Claude => undo_claude(&path, &backup_path())?,
        Provider::Codex => undo_codex(&path, &backup_path())?,
    }
    Ok(path)
}

/// Keys `setup` manages in Claude Code's `settings.json` env block.
const CLAUDE_KEYS: [&str; 4] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
    "ANTHROPIC_API_KEY",
];

fn read_settings(path: &Path) -> Result<Map<String, Value>> {
    match fsx::read_json::<Value>(path)? {
        Some(Value::Object(map)) => Ok(map),
        Some(_) => bail!("{} is not a JSON object", path.display()),
        None => Ok(Map::new()),
    }
}

fn setup_claude(config: &Config, path: &Path, backup_file: &Path) -> Result<()> {
    let mut settings = read_settings(path)?;
    let env = settings
        .entry("env")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("settings.json `env` is not an object")?;

    let mut backup = Backup::load(backup_file)?;
    if backup.claude_env.is_none() {
        let previous = CLAUDE_KEYS
            .iter()
            .map(|k| (k.to_string(), env.get(*k).cloned().unwrap_or(Value::Null)))
            .collect();
        backup.claude_env = Some(previous);
        backup.save(backup_file)?;
    }
    env.insert("ANTHROPIC_BASE_URL".into(), config.base_url().into());
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), config.api_key.clone().into());
    env.insert(
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".into(),
        "1".into(),
    );
    // An API key alongside the token makes Claude Code warn about conflicts.
    env.remove("ANTHROPIC_API_KEY");
    // The file now holds the slopmax key, so keep it private.
    Ok(fsx::write_json(path, &settings)?)
}

fn undo_claude(path: &Path, backup_file: &Path) -> Result<()> {
    let mut backup = Backup::load(backup_file)?;
    let previous = backup
        .claude_env
        .take()
        .context("no Claude Code setup to undo")?;
    let mut settings = read_settings(path)?;
    if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) {
        for (key, value) in previous {
            match value {
                Value::Null => env.remove(&key),
                value => env.insert(key, value),
            };
        }
    }
    fsx::write_json(path, &settings)?;
    backup.save(backup_file)
}

fn read_toml(path: &Path) -> Result<DocumentMut> {
    match std::fs::read_to_string(path) {
        Ok(text) => text
            .parse()
            .with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

fn setup_codex(config: &Config, path: &Path, backup_file: &Path) -> Result<()> {
    let mut doc = read_toml(path)?;
    let mut backup = Backup::load(backup_file)?;
    if backup.codex_model_provider.is_none() {
        let previous = doc
            .get("model_provider")
            .and_then(Item::as_str)
            .filter(|p| *p != CODEX_PROVIDER)
            .map(str::to_owned);
        backup.codex_model_provider = Some(previous);
        backup.save(backup_file)?;
    }
    doc["model_provider"] = value(CODEX_PROVIDER);

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
    providers.insert(CODEX_PROVIDER, Item::Table(table));

    // The file now holds the slopmax key, so keep it private.
    Ok(fsx::write_private(path, doc.to_string().as_bytes())?)
}

fn undo_codex(path: &Path, backup_file: &Path) -> Result<()> {
    let mut backup = Backup::load(backup_file)?;
    let previous = backup
        .codex_model_provider
        .take()
        .context("no Codex setup to undo")?;
    let mut doc = read_toml(path)?;
    match previous {
        Some(provider) => doc["model_provider"] = value(provider),
        None => {
            doc.remove("model_provider");
        }
    }
    if let Some(providers) = doc.get_mut("model_providers").and_then(Item::as_table_mut) {
        providers.remove(CODEX_PROVIDER);
    }
    fsx::write_private(path, doc.to_string().as_bytes())?;
    backup.save(backup_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            api_key: "sm-test".into(),
            ..Config::default()
        }
    }

    #[test]
    fn codex_overrides_define_a_custom_provider() {
        let args = codex_args(&config()).join(" ");
        assert!(args.contains(r#"-c model_provider="slopmax""#), "{args}");
        assert!(args.contains(r#"model_providers.slopmax.base_url="http://127.0.0.1:7567/codex""#));
        assert!(args.contains(r#"model_providers.slopmax.env_key="SLOPMAX_API_KEY""#));
        assert!(args.contains(r#"model_providers.slopmax.name="OpenAI""#));
    }

    #[test]
    fn codex_overrides_sit_at_the_users_level() {
        let strings = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Session subcommands take the overrides after the subcommand, next
        // to the user's own `-c` flags.
        let argv = codex_argv(&config(), &strings(&["exec", "-c", "model=\"m\"", "hi"]));
        assert_eq!(argv[0], "exec");
        assert_eq!(argv[1], "-c");
        assert!(argv[2].starts_with("model_provider="));
        assert_eq!(&argv[argv.len() - 3..], ["-c", "model=\"m\"", "hi"]);
        // The interactive TUI (optionally with a prompt) takes them at the root.
        let argv = codex_argv(&config(), &strings(&["fix the bug"]));
        assert_eq!(argv[0], "-c");
        assert_eq!(argv.last().unwrap(), "fix the bug");
    }

    #[test]
    fn claude_env_points_at_the_proxy() {
        let script = env_script(Provider::Claude, &config(), Path::new("slopmax"));
        assert!(script.contains("export ANTHROPIC_BASE_URL=http://127.0.0.1:7567"));
        assert!(script.contains("export ANTHROPIC_AUTH_TOKEN=sm-test"));
        assert!(script.contains("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1"));
        assert!(script.contains("unset ANTHROPIC_API_KEY"));
    }

    #[test]
    fn codex_env_hands_off_to_run() {
        let script = env_script(
            Provider::Codex,
            &config(),
            Path::new("/opt/my tools/slopmax"),
        );
        assert_eq!(
            script,
            "codex() { '/opt/my tools/slopmax' run codex \"$@\"; }\n"
        );
    }

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("slopmax-agents-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_setup_round_trips_and_keeps_other_settings() {
        let dir = temp("claude");
        let (settings, backup) = (dir.join("settings.json"), dir.join("backup.json"));
        let original = json!({
            "theme": "auto",
            "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", "ANTHROPIC_API_KEY": "sk-x", "OTHER": "1" }
        });
        std::fs::write(&settings, original.to_string()).unwrap();

        setup_claude(&config(), &settings, &backup).unwrap();
        let wired: Value = fsx::read_json(&settings).unwrap().unwrap();
        assert_eq!(wired["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:7567");
        assert_eq!(wired["env"]["ANTHROPIC_AUTH_TOKEN"], "sm-test");
        assert!(wired["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(wired["env"]["OTHER"], "1");
        assert_eq!(wired["theme"], "auto");

        // A second setup must not overwrite the original backup.
        setup_claude(&config(), &settings, &backup).unwrap();
        undo_claude(&settings, &backup).unwrap();
        let restored: Value = fsx::read_json(&settings).unwrap().unwrap();
        assert_eq!(restored, original);
        assert!(
            undo_claude(&settings, &backup).is_err(),
            "nothing left to undo"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_setup_round_trips_and_keeps_comments() {
        let dir = temp("codex");
        let (file, backup) = (dir.join("config.toml"), dir.join("backup.json"));
        let original = "# my config\nmodel_provider = \"cliproxyapi\"\nmodel = \"gpt-6-sol\"\n\n[model_providers.cliproxyapi]\nname = \"cliproxyapi\"\n";
        std::fs::write(&file, original).unwrap();

        setup_codex(&config(), &file, &backup).unwrap();
        let wired = std::fs::read_to_string(&file).unwrap();
        assert!(wired.starts_with("# my config"), "{wired}");
        assert!(wired.contains(r#"model_provider = "slopmax""#));
        assert!(wired.contains("[model_providers.slopmax]"));
        assert!(wired.contains(r#"base_url = "http://127.0.0.1:7567/codex""#));
        assert!(wired.contains(r#"experimental_bearer_token = "sm-test""#));
        assert!(wired.contains("[model_providers.cliproxyapi]"));

        undo_codex(&file, &backup).unwrap();
        let restored = std::fs::read_to_string(&file).unwrap();
        assert!(
            restored.contains(r#"model_provider = "cliproxyapi""#),
            "{restored}"
        );
        assert!(!restored.contains("slopmax"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shell_quoting() {
        assert_eq!(shell_quote("plain-value"), "plain-value");
        assert_eq!(shell_quote("it's"), r#"'it'\''s'"#);
    }
}
