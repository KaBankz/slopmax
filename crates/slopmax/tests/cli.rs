//! The `slopmax` binary end to end, in a sandbox.
//!
//! Every command runs with its homes (`SLOPMAX_HOME`, `HOME`,
//! `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`) in a fresh temp
//! dir, the proxy on a free port, and stdin closed. Outbound HTTPS goes to a
//! dead local proxy, so nothing reaches the internet, and the programs that
//! would touch the machine (`launchctl`, `systemctl`, `loginctl`,
//! `security`, `open`, `xdg-open`) are stubs that record their arguments
//! and fail. `SLOPMAX_NO_SERVICE` keeps slopmax from looking for a login
//! service at all: launchd's and systemd's domains are the user's, whatever
//! the environment moves, so no test may reach them.

use std::io::Write as _;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use slopmax_core::account::{Account, Endpoint, Link, Store, Tokens};
use slopmax_core::ledger::Entry;
use slopmax_core::net::body;
use slopmax_core::net::server::{self, Request, Response};
use slopmax_core::provider::ProviderId;
use slopmax_core::time::{SignedDuration, Timestamp};
use slopmax_core::wire::Dialect;

/// A dead proxy: connections to it are refused at once (on Windows too, as
/// slopmax turns off SYN resends for local connections).
const NOWHERE: &str = "http://127.0.0.1:9";

const STUBS: &[&str] = &[
    "launchctl",
    "systemctl",
    "loginctl",
    "security",
    "open",
    "xdg-open",
];

struct Sandbox {
    root: PathBuf,
    home: PathBuf,
    slopmax: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
    stubs: PathBuf,
    port: u16,
}

#[derive(Debug)]
struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Out {
    #[track_caller]
    fn ok(self) -> Self {
        assert_eq!(self.code, 0, "{self:#?}");
        self
    }

    #[track_caller]
    fn fails(self, code: i32, says: &str) -> Self {
        assert_eq!(self.code, code, "{self:#?}");
        assert!(
            self.stderr.contains(says),
            "stderr should say {says:?}: {self:#?}"
        );
        self
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("slopmax-cli-{name}-{}-{nanos}", std::process::id()));
        let sandbox = Self {
            home: root.join("home"),
            slopmax: root.join("slopmax"),
            claude: root.join("claude"),
            codex: root.join("codex"),
            stubs: root.join("bin"),
            port: free_port(),
            root,
        };
        for dir in [
            &sandbox.home,
            &sandbox.claude,
            &sandbox.codex,
            &sandbox.stubs,
            &sandbox.root.join("xdg"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for stub in STUBS {
            let path = sandbox.stubs.join(stub);
            std::fs::write(
                &path,
                "#!/bin/sh\necho \"$(basename \"$0\") $*\" >> \"$STUB_LOG\"\nexit 1\n",
            )
            .unwrap();
            make_executable(&path);
        }
        sandbox
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_slopmax"));
        let system: &[&str] = if cfg!(windows) {
            &[]
        } else {
            &["/usr/bin", "/bin"]
        };
        let mut path: Vec<std::path::PathBuf> = vec![self.stubs.clone()];
        path.extend(system.iter().map(std::path::PathBuf::from));
        // Windows' own programs, and what its networking needs to start.
        if let Some(root) = std::env::var_os("SystemRoot") {
            path.push(std::path::PathBuf::from(&root).join("System32"));
        }
        command
            .args(args)
            .env_clear()
            .env("PATH", std::env::join_paths(path).unwrap())
            .env("HOME", &self.home)
            // Where Windows looks for the user's home.
            .env("USERPROFILE", &self.home)
            .env("SLOPMAX_HOME", &self.slopmax)
            .env("CLAUDE_CONFIG_DIR", &self.claude)
            .env("CODEX_HOME", &self.codex)
            .env("XDG_CONFIG_HOME", self.root.join("xdg"))
            .env("SLOPMAX_LISTEN", format!("127.0.0.1:{}", self.port))
            .env("HTTPS_PROXY", NOWHERE)
            .env("HTTP_PROXY", NOWHERE)
            .env("ALL_PROXY", NOWHERE)
            .env("STUB_LOG", self.root.join("stubs.log"))
            .env("SLOPMAX_NO_SERVICE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Coverage runs write a profile per process; Windows needs its
        // system directories for sockets and processes to work at all.
        for name in [
            "LLVM_PROFILE_FILE",
            "TMPDIR",
            "SystemRoot",
            "windir",
            "TEMP",
            "TMP",
            "ComSpec",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
    }

    fn run(&self, args: &[&str]) -> Out {
        self.finish(self.command(args).spawn().unwrap())
    }

    /// Runs with `input` on stdin.
    fn run_with(&self, args: &[&str], input: &str) -> Out {
        let mut child = self.command(args).stdin(Stdio::piped()).spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        self.finish(child)
    }

    fn finish(&self, child: Child) -> Out {
        let output = child.wait_with_output().unwrap();
        Out {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    fn store(&self) -> Store {
        Store::at(self.slopmax.join("accounts"))
    }

    fn add(&self, account: &Account) {
        self.store().save(account).unwrap();
    }

    fn account(&self, query: &str) -> Account {
        self.store().find(query).unwrap()
    }

    fn stub_calls(&self) -> String {
        std::fs::read_to_string(self.root.join("stubs.log")).unwrap_or_default()
    }

    fn config(&self) -> PathBuf {
        self.slopmax.join("config.toml")
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // A proxy left by a failed test would outlive it.
        let _ = self.command(&["stop"]).output();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_: &Path) {}

fn in_hours(hours: i64) -> Timestamp {
    Timestamp::now() + SignedDuration::from_hours(hours)
}

fn claude(email: &str) -> Account {
    let mut account = Account::new(
        ProviderId::Claude,
        Tokens {
            access_token: format!("tok-{email}"),
            refresh_token: Some(format!("ref-{email}")),
            expires_at: Some(in_hours(8)),
            ..Tokens::default()
        },
    );
    account.email = Some(email.to_owned());
    account.account_id = Some(format!("uuid-{email}"));
    account.plan = Some("max 20x".into());
    account.assign_id();
    account
}

fn codex(email: &str) -> Account {
    let mut account = Account::new(
        ProviderId::Codex,
        Tokens {
            access_token: format!("tok-{email}"),
            refresh_token: Some(format!("ref-{email}")),
            expires_at: Some(in_hours(8)),
            ..Tokens::default()
        },
    );
    account.email = Some(email.to_owned());
    account.account_id = Some(format!("ws-{email}"));
    account.plan = Some("pro".into());
    account.assign_id();
    account
}

fn key(provider: ProviderId, key: &str) -> Account {
    Account::new(
        provider,
        Tokens {
            access_token: key.to_owned(),
            ..Tokens::default()
        },
    )
}

/// Waits for `check` to hold, for up to 10 seconds.
fn eventually(what: &str, check: impl Fn() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out: {what}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn help_version_and_completions_print_and_succeed() {
    let s = Sandbox::new("help");
    let help = s.run(&["--help"]).ok();
    assert!(help.stdout.contains("Multi-account switcher"), "{help:?}");
    assert!(help.stdout.contains("setup"));
    let version = s.run(&["--version"]).ok();
    assert!(version.stdout.contains(env!("CARGO_PKG_VERSION")));
    let usage_help = s.run(&["help", "usage"]).ok();
    assert!(usage_help.stdout.contains("--by"), "{usage_help:?}");
    let login_help = s.run(&["login", "--help"]).ok();
    assert!(login_help.stdout.contains("compat"), "{login_help:?}");
    // Printing help never creates state.
    assert!(!s.slopmax.exists());
    for shell in ["bash", "zsh", "fish"] {
        let script = s.run(&["completions", shell]).ok();
        assert!(script.stdout.contains("slopmax"), "{shell}: {script:?}");
        assert!(script.stdout.contains("setup"), "{shell}");
    }
}

#[test]
fn mistakes_explain_themselves_and_fail() {
    let s = Sandbox::new("mistakes");
    // The parser's errors exit 2 with a hint.
    s.run(&["statsu"]).fails(2, "status");
    s.run(&["label"]).fails(2, "<ACCOUNT>");
    s.run(&["completions", "tcsh"]).fails(2, "tcsh");
    s.run(&["status", "--frobnicate"]).fails(2, "--frobnicate");

    // The commands' own checks exit 1.
    s.run(&["status", "--watch", "--json"])
        .fails(1, "--json cannot be combined with --watch");
    s.run(&["usage", "--by", "week"])
        .fails(1, "--by takes day, model, or account");
    s.run(&["usage", "fortnight"]).fails(2, "fortnight");
    s.run(&["logs", "-n", "many"])
        .fails(1, "--lines takes a number");
    s.run(&["key", "add"]).fails(1, "needs the key's name");
    s.run(&["key", "remove", "ghost"])
        .fails(1, "no key named \"ghost\"");
    s.run(&["login", "compat"]).fails(1, "--url <base url>");
    s.run(&["login", "claude", "--url", "http://localhost:1/v1"])
        .fails(1, "are for `slopmax login compat`");
    s.run(&["login", "compat", "--url", "ftp://host"])
        .fails(1, "http:// or https://");
    s.run(&[
        "login",
        "compat",
        "--url",
        "http://h/v1",
        "--dialect",
        "soap",
    ])
    .fails(1, "--dialect takes chat, responses, or messages");
    s.run(&["login", "claude", "--device"])
        .fails(1, "--device works for ChatGPT accounts");
    s.run(&["notify"]).fails(1, "notifications are off");
    s.run(&["label", "1", "work"])
        .fails(1, "no account matches \"1\"");
    s.run(&["priority", "x", "high"]).fails(1, "");
    s.run(&["setup", "claude", "--undo"])
        .fails(1, "no Claude Code setup to undo");
    s.run(&["import", "nowhere"]).fails(2, "nowhere");

    // An unreadable config is reported, not overwritten.
    std::fs::create_dir_all(&s.slopmax).unwrap();
    std::fs::write(s.config(), "listen = [").unwrap();
    s.run(&["status"]).fails(1, "error:");
    assert_eq!(std::fs::read_to_string(s.config()).unwrap(), "listen = [");
}

#[test]
fn a_bad_listen_override_is_named() {
    let s = Sandbox::new("listen");
    let out = s
        .command(&["status"])
        .env("SLOPMAX_LISTEN", "not-an-address")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("SLOPMAX_LISTEN"));
}

#[test]
fn status_shows_accounts_from_disk() {
    let s = Sandbox::new("status");
    let empty = s.run(&[]).ok();
    assert!(empty.stdout.contains("No accounts yet"), "{empty:?}");
    // A first run creates the config from its template.
    assert!(s.config().is_file());

    s.add(&claude("a@x.dev"));
    s.add(&codex("b@x.dev"));
    let mut kimi = key(ProviderId::Compat, "sk-local");
    kimi.endpoint = Some(Endpoint {
        base_url: "http://localhost:11434/v1".into(),
        dialect: Dialect::Chat,
        models: vec!["qwen3".into()],
    });
    kimi.assign_id();
    s.add(&kimi);
    s.add(&key(ProviderId::Anthropic, "sk-ant-1234"));

    let json: Value = serde_json::from_str(&s.run(&["status", "--json"]).ok().stdout).unwrap();
    let accounts = json["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 4, "{json:#}");
    let names: Vec<&str> = accounts
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"a@x.dev"), "{names:?}");
    assert!(names.contains(&"b@x.dev"), "{names:?}");
    assert!(names.contains(&"localhost:11434"), "{names:?}");

    let table = s.run(&["ls"]).ok().stdout;
    assert!(table.contains("CLAUDE"), "{table}");
    assert!(table.contains("CODEX"), "{table}");
    assert!(table.contains("a@x.dev"), "{table}");
    assert!(table.contains("max 20x"), "{table}");
    // Without a terminal, a bare `slopmax` is `status`.
    assert_eq!(s.run(&[]).ok().stdout, table);
}

#[test]
fn refreshing_status_reports_unreachable_providers_without_failing() {
    let s = Sandbox::new("refresh");
    s.add(&codex("b@x.dev"));
    let out = s.run(&["status", "--refresh", "--json"]).ok();
    let json: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(json["accounts"].as_array().unwrap().len(), 1, "{json:#}");
}

#[test]
fn account_commands_change_the_store() {
    let s = Sandbox::new("accounts");
    let a = claude("a@x.dev");
    let b = claude("b@x.dev");
    s.add(&a);
    s.add(&b);

    let out = s.run(&["label", "a@x.dev", "work"]).ok();
    assert!(out.stdout.contains("work"), "{out:?}");
    assert_eq!(s.account(&a.id).label.as_deref(), Some("work"));

    let out = s.run(&["priority", "work", "-2"]).ok();
    assert!(out.stdout.contains("priority -2"), "{out:?}");
    assert_eq!(s.account(&a.id).priority, -2);

    s.run(&["disable", "work"]).ok();
    assert!(s.account(&a.id).disabled);
    let out = s.run(&["enable", &a.id]).ok();
    assert!(out.stdout.contains("Enabled work"), "{out:?}");
    assert!(!s.account(&a.id).disabled);

    // With no daemon running, `use` writes the pins into state.toml itself.
    let state = s.slopmax.join("state.toml");
    let pins = |state: &std::path::Path| -> toml_edit::Item {
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(state).unwrap().parse().unwrap();
        doc.get("pins").cloned().unwrap_or(toml_edit::Item::None)
    };
    let out = s.run(&["use", "b@x.dev"]).ok();
    assert!(
        out.stdout.contains("New claude sessions will use"),
        "{out:?}"
    );
    assert_eq!(pins(&state)["claude"].as_str(), Some(b.id.as_str()));
    let out = s.run(&["use", "auto"]).ok();
    assert!(out.stdout.contains("automatically"), "{out:?}");
    assert!(pins(&state).get("claude").is_none());

    // Removing a pinned account drops its pin too.
    s.run(&["use", "b@x.dev"]).ok();
    let out = s.run(&["remove", "b@x.dev"]).ok();
    assert!(out.stdout.contains("Removed b@x.dev"), "{out:?}");
    assert!(s.store().get(&b.id).unwrap().is_none());
    assert!(pins(&state).get("claude").is_none());

    // Ambiguous and missing references are refused.
    s.add(&claude("c@x.dev"));
    s.run(&["remove", "claude-"]).fails(1, "ambiguous");
    s.run(&["disable", "nobody"]).fails(1, "no account matches");
}

#[test]
fn own_takes_over_linked_accounts() {
    let s = Sandbox::new("own");
    let out = s.run(&["own", "all"]).ok();
    assert!(
        out.stdout.contains("No accounts follow another tool"),
        "{out:?}"
    );

    let mut linked = codex("l@x.dev");
    linked.link = Some(Link {
        tool: "cliproxyapi".into(),
        path: s.home.join(".cli-proxy-api/codex-l.json"),
    });
    s.add(&linked);
    s.add(&codex("m@x.dev"));

    let out = s.run(&["own", "m@x.dev"]).ok();
    assert!(out.stdout.contains("already refreshes here"), "{out:?}");
    let out = s.run(&["own", "all"]).ok();
    assert!(
        out.stdout.contains("slopmax now refreshes l@x.dev"),
        "{out:?}"
    );
    assert!(out.stdout.contains("was following cliproxyapi"), "{out:?}");
    assert!(s.account(&linked.id).link.is_none());
}

#[test]
fn keys_are_added_listed_and_revoked() {
    let s = Sandbox::new("keys");
    let out = s.run(&["key"]).ok();
    assert!(out.stdout.contains("No client keys"), "{out:?}");

    let added = s
        .run(&["key", "add", "laptop", "--models", "gpt-*, claude-* ,"])
        .ok();
    let secret = added.stdout.trim();
    assert!(!secret.is_empty(), "{added:?}");
    assert!(
        added.stderr.contains("Added the key \"laptop\""),
        "{added:?}"
    );
    s.run(&["key", "add", "phone"]).ok();
    let config = std::fs::read_to_string(s.config()).unwrap();
    assert!(config.contains(secret), "{config}");

    let list = s.run(&["key", "list"]).ok().stdout;
    assert!(list.contains("laptop"), "{list}");
    assert!(list.contains("gpt-*, claude-*"), "{list}");
    assert!(list.contains("phone"), "{list}");
    assert!(list.contains("any model"), "{list}");
    assert!(!list.contains(secret), "keys are never listed: {list}");

    let out = s.run(&["key", "remove", "laptop"]).ok();
    assert!(out.stdout.contains("Revoked the key \"laptop\""), "{out:?}");
    let list = s.run(&["key", "list"]).ok().stdout;
    assert!(!list.contains("laptop"), "{list}");
    assert!(
        !std::fs::read_to_string(s.config())
            .unwrap()
            .contains(secret)
    );
}

fn entry(at: Timestamp, account: &str, model: &str, status: u16) -> Entry {
    Entry {
        at,
        account: account.into(),
        provider: ProviderId::Claude,
        model: Some(model.into()),
        status,
        input: 1_000,
        output: 200,
        cache_read: 5_000,
        cache_write: 300,
        ms: 1_200,
        first_byte_ms: Some(300),
        attempts: 1,
        agent: Some("claude".into()),
        session: None,
        end: None,
    }
}

fn write_ledger(s: &Sandbox, entries: &[Entry]) {
    let dir = s.slopmax.join("usage");
    std::fs::create_dir_all(&dir).unwrap();
    for entry in entries {
        let (year, month, _) = entry.at.date(SignedDuration::ZERO);
        let path = dir.join(format!("{year:04}-{month:02}.jsonl"));
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{}", serde_json::to_string(entry).unwrap()).unwrap();
    }
}

#[test]
fn usage_totals_the_ledger() {
    let s = Sandbox::new("usage");
    let out = s.run(&["usage"]).ok();
    assert!(
        out.stdout
            .contains("No requests recorded for the last 7 days"),
        "{out:?}"
    );

    let a = claude("a@x.dev");
    s.add(&a);
    let now = Timestamp::now();
    write_ledger(
        &s,
        &[
            entry(now, &a.id, "claude-sonnet-4-6", 200),
            entry(now, &a.id, "claude-sonnet-4-6", 200),
            entry(now, &a.id, "mystery-model", 200),
            entry(now, &a.id, "claude-sonnet-4-6", 529),
            entry(
                now - SignedDuration::from_hours(24 * 20),
                &a.id,
                "claude-opus-4-1",
                200,
            ),
        ],
    );

    let week = s.run(&["usage"]).ok().stdout;
    assert!(week.contains("DAY"), "{week}");
    assert!(week.contains("total"), "{week}");
    assert!(week.contains("the last 7 days"), "{week}");
    assert!(
        week.contains("1 request to models without a price"),
        "{week}"
    );
    assert!(week.contains("1 request failed"), "{week}");

    let models = s.run(&["usage", "today", "--by", "model"]).ok().stdout;
    assert!(models.contains("MODEL"), "{models}");
    assert!(models.contains("claude-sonnet-4-6"), "{models}");
    assert!(models.contains("mystery-model"), "{models}");
    assert!(models.contains("Usage for today"), "{models}");

    let accounts = s.run(&["usage", "all", "-b", "account"]).ok().stdout;
    assert!(accounts.contains("a@x.dev"), "{accounts}");
    assert!(accounts.contains("all time"), "{accounts}");

    let json: Value =
        serde_json::from_str(&s.run(&["usage", "30d", "--json"]).ok().stdout).unwrap();
    assert_eq!(json["total"]["requests"], 4, "{json:#}");
    assert_eq!(json["total"]["failed"], 1, "{json:#}");
    let week: Value = serde_json::from_str(&s.run(&["usage", "--json"]).ok().stdout).unwrap();
    assert_eq!(week["total"]["requests"], 3, "{week:#}");
}

#[test]
fn setup_wires_the_agents_and_undo_restores_their_files_exactly() {
    let s = Sandbox::new("setup");
    let settings = s.claude.join("settings.json");
    let original_settings = "{\n  \"model\": \"opus\",\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://elsewhere.example\",\n    \"KEEP\": \"1\"\n  }\n}\n";
    std::fs::write(&settings, original_settings).unwrap();
    let toml = s.codex.join("config.toml");
    let original_toml = "# mine\nmodel = \"gpt-5\"\nmodel_provider = \"other\"\n\n[model_providers.other]\nbase_url = \"https://other.example/v1\"\n";
    std::fs::write(&toml, original_toml).unwrap();

    let base = format!("http://127.0.0.1:{}", s.port);
    let out = s.run(&["setup", "claude"]).ok();
    assert!(
        out.stdout.contains("Claude Code now uses slopmax"),
        "{out:?}"
    );
    let wired: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    assert!(
        wired["env"]["ANTHROPIC_BASE_URL"]
            .as_str()
            .unwrap()
            .starts_with(&base),
        "{wired:#}"
    );
    assert_eq!(wired["env"]["KEEP"], "1");
    assert_eq!(wired["model"], "opus");

    let out = s.run(&["setup", "codex"]).ok();
    assert!(out.stdout.contains("Codex now uses slopmax"), "{out:?}");
    let wired_toml = std::fs::read_to_string(&toml).unwrap();
    assert!(wired_toml.contains(&base), "{wired_toml}");
    assert!(wired_toml.contains("# mine"), "{wired_toml}");

    // Setting up twice keeps the first backup, so undo still restores the
    // original.
    s.run(&["setup", "claude"]).ok();
    s.run(&["setup", "codex"]).ok();

    let doctor = s.run(&["doctor"]).stdout;
    assert!(doctor.contains("Claude Code"), "{doctor}");

    let out = s.run(&["setup", "claude", "--undo"]).ok();
    assert!(out.stdout.contains("Restored Claude Code"), "{out:?}");
    let restored: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    let original: Value = serde_json::from_str(original_settings).unwrap();
    assert_eq!(restored, original);

    let out = s.run(&["setup", "codex", "--undo"]).ok();
    assert!(out.stdout.contains("Restored Codex"), "{out:?}");
    let restored_toml = std::fs::read_to_string(&toml).unwrap();
    assert_eq!(restored_toml, original_toml);

    s.run(&["setup", "codex", "--undo"])
        .fails(1, "no Codex setup to undo");
}

#[test]
fn setup_on_a_fresh_machine_and_undo_leave_no_wiring() {
    let s = Sandbox::new("fresh-setup");
    s.run(&["setup", "claude"]).ok();
    s.run(&["setup", "codex"]).ok();
    let settings = s.claude.join("settings.json");
    let toml = s.codex.join("config.toml");
    assert!(settings.is_file());
    assert!(toml.is_file());

    s.run(&["setup", "claude", "--undo"]).ok();
    s.run(&["setup", "codex", "--undo"]).ok();
    let base = format!("127.0.0.1:{}", s.port);
    let left = std::fs::read_to_string(&settings).unwrap_or_default();
    assert!(!left.contains(&base), "{left}");
    let left = std::fs::read_to_string(&toml).unwrap_or_default();
    assert!(!left.contains(&base), "{left}");
}

#[test]
fn env_prints_shell_setup_for_each_agent() {
    let s = Sandbox::new("env");
    let base = format!("http://127.0.0.1:{}", s.port);
    let claude = s.run(&["env", "claude"]).ok().stdout;
    assert!(claude.contains("ANTHROPIC_BASE_URL"), "{claude}");
    assert!(claude.contains(&base), "{claude}");
    let codex = s.run(&["env", "codex"]).ok().stdout;
    assert!(
        codex.contains(&base) || codex.contains("slopmax"),
        "{codex}"
    );
}

#[test]
fn doctor_reports_findings_and_fails_on_problems() {
    let s = Sandbox::new("doctor");
    let mut linked = codex("l@x.dev");
    linked.link = Some(Link {
        tool: "cliproxyapi".into(),
        path: s.home.join(".cli-proxy-api/codex-l.json"),
    });
    s.add(&linked);
    let mut signed_out = claude("gone@x.dev");
    signed_out.auth_error = Some("refresh token revoked".into());
    s.add(&signed_out);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = s
            .slopmax
            .join("accounts")
            .join(format!("{}.toml", signed_out.id));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    // The network is unreachable here, which is a problem.
    let out = s.run(&["doctor"]);
    assert_eq!(out.code, 1, "{out:#?}");
    let text = &out.stdout;
    for section in [
        "Proxy",
        "Accounts",
        "Claude Code",
        "Codex",
        "CLIProxyAPI",
        "Network",
    ] {
        assert!(text.contains(section), "{section}: {text}");
    }
    assert!(text.contains("not running"), "{text}");
    assert!(text.contains("cannot reach Anthropic"), "{text}");
    assert!(text.contains("fix:"), "{text}");
    assert!(text.contains("problem"), "{text}");
    #[cfg(unix)]
    assert!(text.contains("readable by other users"), "{text}");
}

#[test]
fn doctor_names_what_holds_the_port() {
    let s = Sandbox::new("doctor-port");
    // Another program holds the port and hangs up on whoever connects.
    let held = TcpListener::bind(("127.0.0.1", s.port)).unwrap();
    std::thread::spawn(move || {
        for connection in held.incoming() {
            drop(connection);
        }
    });
    let out = s.run(&["doctor"]);
    assert_eq!(out.code, 1, "{out:#?}");
    assert!(
        out.stdout.contains(&format!("port {} is taken", s.port)),
        "{out:#?}"
    );
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn import_brings_over_codex_and_cliproxyapi_logins() {
    let s = Sandbox::new("import");
    let out = s.run(&["import"]).ok();
    assert!(out.stdout.contains("No logins found"), "{out:?}");
    // Without a credentials file, Claude Code's login is looked up in the
    // keychain on macOS (a stub here).
    if cfg!(target_os = "macos") {
        assert!(s.stub_calls().contains("security find-generic-password"));
    }
    std::fs::remove_file(s.root.join("stubs.log")).ok();

    // Claude Code's login has expired with nothing to refresh it, so it is
    // skipped without the network or the keychain.
    write(
        &s.claude.join(".credentials.json"),
        &json!({"claudeAiOauth": {"accessToken": "old", "expiresAt": 1000}}).to_string(),
    );
    write(
        &s.codex.join("auth.json"),
        &json!({"tokens": {"access_token": "tok-codex", "refresh_token": "ref-codex"},
                "last_refresh": "2026-10-01T00:00:00Z"})
        .to_string(),
    );
    let cpa = s.home.join(".cli-proxy-api");
    write(
        &cpa.join("codex-a.json"),
        &json!({"type": "codex", "access_token": "tok-a", "refresh_token": "ref-a",
                "email": "a@x.dev", "account_id": "ws-a", "plan_type": "plus",
                "label": "cpa-a", "priority": "2"})
        .to_string(),
    );
    write(
        &cpa.join("claude-b.json"),
        &json!({"type": "claude", "access_token": "tok-b", "refresh_token": "ref-b",
                "expired": "2020-01-01T00:00:00Z", "email": "b@x.dev",
                "account_uuid": "uuid-b", "organization_name": "B Corp"})
        .to_string(),
    );
    write(
        &cpa.join("gemini.json"),
        &json!({"type": "gemini"}).to_string(),
    );
    write(&cpa.join("broken.json"), "{");
    write(
        &cpa.join("empty.json"),
        &json!({"type": "codex"}).to_string(),
    );

    let out = s.run(&["import"]).ok();
    let text = &out.stdout;
    assert!(text.contains("skipped"), "{text}");
    assert!(text.contains("login expired"), "{text}");
    assert!(text.contains("no access token"), "{text}");
    assert!(text.contains("cpa-a"), "{text}");
    assert!(text.contains("b@x.dev"), "{text}");
    assert!(text.contains("linked:"), "{text}");
    assert!(text.contains("note:"), "{text}");
    let accounts = s.store().list().unwrap();
    assert_eq!(accounts.len(), 3, "{accounts:#?}");
    let a = s.account("cpa-a");
    assert_eq!(a.priority, 2);
    assert!(a.link.is_some());
    assert!(s.account("b@x.dev").link.is_some());

    // Importing again updates the same accounts; --own stops following.
    let out = s.run(&["import", "cliproxyapi", "--own"]).ok();
    assert!(out.stdout.contains('~'), "{out:?}");
    assert!(!out.stdout.contains("linked:"), "{out:?}");
    assert_eq!(s.store().list().unwrap().len(), 3);
    assert!(s.account("cpa-a").link.is_none());

    let out = s.run(&["import", "codex"]).ok();
    assert!(out.stdout.contains("auth.json"), "{out:?}");
    assert!(
        !s.stub_calls().contains("security"),
        "the keychain was consulted: {}",
        s.stub_calls()
    );
}

/// A compatible endpoint that lists two models for one key.
async fn endpoint_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handler = |request: Request| async move {
        let authorized = request
            .headers()
            .get("authorization")
            .is_some_and(|v| v == "Bearer sk-good");
        let (status, text) = match (request.uri().path(), authorized) {
            ("/v1/models", true) => (200, r#"{"data":[{"id":"qwen3"},{"id":"llama4"}]}"#),
            ("/v1/models", false) => (401, "{}"),
            _ => (404, ""),
        };
        let mut response = Response::new(body::full(text));
        *response.status_mut() = http::StatusCode::from_u16(status).unwrap();
        response
    };
    tokio::spawn(server::serve(listener, handler, std::future::pending()));
    url
}

#[tokio::test(flavor = "multi_thread")]
async fn login_with_keys_reads_them_from_stdin() {
    let url = endpoint_server().await;
    let s = Arc::new(Sandbox::new("login"));
    let run = |args: Vec<String>, input: &'static str| {
        let s = s.clone();
        tokio::task::spawn_blocking(move || {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            s.run_with(&args, input)
        })
    };
    let v1 = format!("{url}/v1/");

    let out = run(
        vec!["login".into(), "compat".into(), "--url".into(), v1.clone()],
        "sk-good\n",
    )
    .await
    .unwrap()
    .ok();
    assert!(out.stdout.contains("Connected compat account"), "{out:?}");
    assert!(out.stdout.contains("It serves qwen3, llama4."), "{out:?}");
    let account = s.store().list().unwrap().pop().unwrap();
    let endpoint = account.endpoint.unwrap();
    assert_eq!(endpoint.base_url, format!("{url}/v1"));
    assert_eq!(endpoint.models, ["qwen3", "llama4"]);

    // Connecting it again updates the account.
    let out = run(
        vec![
            "login".into(),
            "compat".into(),
            "--url".into(),
            v1.clone(),
            "--models".into(),
            "qwen3".into(),
            "--label".into(),
            "box".into(),
        ],
        "sk-good",
    )
    .await
    .unwrap()
    .ok();
    assert!(out.stdout.contains("Updated compat account box"), "{out:?}");

    let out = run(
        vec!["login".into(), "compat".into(), "--url".into(), v1.clone()],
        "sk-bad",
    )
    .await
    .unwrap();
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("rejected the key"), "{out:?}");

    let out = run(
        vec![
            "login".into(),
            "compat".into(),
            "--url".into(),
            format!("{url}/elsewhere"),
            "--dialect".into(),
            "messages".into(),
        ],
        "",
    )
    .await
    .unwrap();
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("name them with --models"), "{out:?}");

    // A key the provider cannot be asked about (no network here) is kept;
    // with a subscription beside it, it says how it overflows.
    s.add(&claude("a@x.dev"));
    let out = run(vec!["login".into(), "anthropic".into()], "sk-ant-api-key\n")
        .await
        .unwrap()
        .ok();
    assert!(
        out.stdout.contains("Connected anthropic account"),
        "{out:?}"
    );
    assert!(out.stdout.contains("paid_overflow"), "{out:?}");
    let out = run(vec!["login".into(), "xai".into()], "xai-key")
        .await
        .unwrap()
        .ok();
    assert!(out.stdout.contains("It serves"), "{out:?}");
    assert!(!out.stdout.contains("paid_overflow"), "{out:?}");

    let out = run(vec!["login".into(), "openai".into()], "")
        .await
        .unwrap();
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("no OpenAI API key entered"), "{out:?}");
}

#[test]
fn sign_ins_that_need_the_network_fail_cleanly() {
    let s = Sandbox::new("device");
    let out = s.run(&["login", "codex", "--device"]);
    assert_eq!(out.code, 1, "{out:#?}");
    assert!(out.stderr.contains("error:"), "{out:#?}");
}

#[test]
fn redeem_needs_an_account_with_resets() {
    let s = Sandbox::new("redeem");
    s.add(&key(ProviderId::OpenAI, "sk-openai-1"));
    s.run(&["redeem", "1", "--yes"])
        .fails(1, "has no limit resets");
    // Listing a ChatGPT account's resets needs the network.
    s.add(&codex("b@x.dev"));
    s.run(&["redeem", "b@x.dev", "--yes"]).fails(1, "error:");
}

// The command runs in a POSIX shell.
#[cfg(unix)]
#[test]
fn notify_sends_a_test_event_through_the_command() {
    let s = Sandbox::new("notify");
    s.run(&["key", "list"]).ok();
    let sent = s.root.join("sent.txt");
    let mut config = std::fs::read_to_string(s.config()).unwrap();
    config.push_str(&format!(
        "\n[notify]\ncommand = \"printf '%s' \\\"$SLOPMAX_EVENT\\\" > '{}'\"\n",
        sent.display()
    ));
    std::fs::write(s.config(), config).unwrap();
    let out = s.run(&["notify"]).ok();
    assert!(out.stdout.contains("Sent a test notification"), "{out:?}");
    assert_eq!(std::fs::read_to_string(&sent).unwrap(), "test");
}

#[test]
fn logs_show_the_tail_of_the_background_log() {
    let s = Sandbox::new("logs");
    let out = s.run(&["logs"]).ok();
    assert!(out.stdout.contains("No log yet"), "{out:?}");
    let lines: String = (1..=50).map(|n| format!("line {n}\n")).collect();
    write(&s.slopmax.join("slopmax.log"), &lines);
    let out = s.run(&["logs", "-n", "3"]).ok();
    assert_eq!(out.stdout, "line 48\nline 49\nline 50\n");
    let out = s.run(&["logs"]).ok();
    assert_eq!(out.stdout.lines().count(), 40);
    assert!(out.stdout.starts_with("line 11\n"), "{out:?}");
}

#[test]
fn the_background_proxy_starts_reports_and_stops() {
    let s = Sandbox::new("background");
    s.add(&key(ProviderId::Anthropic, "sk-ant-9999"));
    let out = s.run(&["stop"]).ok();
    assert!(out.stdout.contains("slopmax is not running"), "{out:?}");

    let out = s.run(&["start"]).ok();
    assert!(out.stdout.contains("slopmax running on"), "{out:?}");
    let out = s.run(&["start"]).ok();
    assert!(out.stdout.contains("already running"), "{out:?}");

    // The status now comes from the proxy.
    let json: Value = serde_json::from_str(&s.run(&["status", "--json"]).ok().stdout).unwrap();
    assert_eq!(json["accounts"].as_array().unwrap().len(), 1, "{json:#}");
    let table = s.run(&["status", "--refresh"]).ok().stdout;
    assert!(table.contains("ANTHROPIC"), "{table}");

    // With it running, changes go through it rather than into the files.
    let id = s.store().list().unwrap()[0].id.clone();
    let out = s.run(&["use", &id]).ok();
    assert!(out.stdout.contains("will use"), "{out:?}");
    let out = s.run(&["label", &id, "work"]).ok();
    assert!(out.stdout.contains("work"), "{out:?}");
    let out = s.run(&["config", "session_ttl_mins", "45"]).ok();
    assert!(out.stdout.contains("applied now"), "{out:?}");
    let key = s.run(&["key", "add", "laptop"]).ok().stdout;
    assert!(key.trim().starts_with("sm-"), "{key}");
    let json: Value = serde_json::from_str(&s.run(&["status", "--json"]).ok().stdout).unwrap();
    let account = &json["accounts"][0];
    assert_eq!(account["name"], "work", "{json:#}");
    assert_eq!(account["pinned"], true, "{json:#}");
    // The daemon saves the pin it was told of at once.
    eventually("the daemon saves the pin", || {
        std::fs::read_to_string(s.slopmax.join("state.toml"))
            .unwrap_or_default()
            .contains(&format!("anthropic = \"{id}\""))
    });

    let out = s.run(&["dashboard", "--print"]).ok();
    assert!(
        out.stdout.contains(&format!("127.0.0.1:{}", s.port)),
        "{out:?}"
    );
    assert!(out.stdout.contains("ssh -L"), "{out:?}");
    // Without --print it asks the system to open it (a stub here).
    let out = s.run(&["dashboard"]).ok();
    if cfg!(target_os = "macos") {
        assert!(out.stdout.contains("Opened the dashboard"), "{out:?}");
        eventually("the browser is asked to open it", || {
            s.stub_calls().contains("open http://127.0.0.1")
        });
    }

    let doctor = s.run(&["doctor"]).stdout;
    assert!(
        doctor.contains(&format!("running on http://127.0.0.1:{}", s.port)),
        "{doctor}"
    );

    // The agent is not installed here, so `run` cannot start it, but the
    // proxy keeps running.
    s.run(&["run", "codex", "exec", "hi"])
        .fails(1, "could not start codex");

    let out = s.run(&["stop"]).ok();
    assert!(out.stdout.contains("slopmax stopped"), "{out:?}");
    eventually("the proxy exits", || {
        s.run(&["stop"]).stdout.contains("not running")
    });
    let log = std::fs::read_to_string(s.slopmax.join("slopmax.log")).unwrap();
    assert!(!log.is_empty());
    let state = std::fs::read_to_string(s.slopmax.join("state.toml")).unwrap();
    assert!(state.contains(&format!("anthropic = \"{id}\"")), "{state}");
}

#[test]
fn serve_runs_in_the_foreground_until_stopped() {
    let s = Sandbox::new("serve");
    // Create the config (and its key) first: processes that each find none
    // would each make a key, and the proxy would keep one the file lacks.
    s.run(&["key", "list"]).ok();
    let mut child = s.command(&["serve"]).spawn().unwrap();
    eventually("the proxy answers", || {
        s.run(&["status", "--json"]).code == 0
            && std::net::TcpStream::connect(("127.0.0.1", s.port)).is_ok()
    });
    eventually("the proxy reports itself", || {
        s.run(&["doctor"]).stdout.contains("running on")
    });
    s.run(&["stop"]).ok();
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{status:?}");
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "serve kept running"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn service_commands_find_no_manager_in_the_sandbox() {
    let s = Sandbox::new("service");
    for action in ["status", "install", "uninstall"] {
        s.run(&["service", action])
            .fails(1, "no supported service manager");
    }
    assert!(!s.home.join("Library/LaunchAgents").exists());
    assert_eq!(s.stub_calls(), "");
}

#[test]
fn unattended_setup_with_nothing_to_pool_fails_and_says_what_to_add() {
    let s = Sandbox::new("init");
    for args in [
        &["setup", "--yes", "--import", "none"][..],
        &["init", "--import", "none"][..],
    ] {
        let out = s.run(args);
        assert_eq!(out.code, 1, "{out:?}");
        assert!(out.stdout.contains("slopmax setup"), "{out:?}");
        assert!(!out.stdout.contains("Routing"), "{out:?}");
        let stderr = &out.stderr;
        assert!(stderr.contains("no accounts are connected"), "{out:?}");
        assert!(stderr.contains("--import claude-code,codex"), "{out:?}");
        assert!(stderr.contains("--keys-from-env"), "{out:?}");
    }
    assert_eq!(s.stub_calls(), "");
}

#[test]
fn setup_flags_that_make_no_sense_are_refused() {
    let s = Sandbox::new("init-flags");
    s.run(&["setup", "--undo"]).fails(
        1,
        "--undo restores one agent: `slopmax setup claude --undo`",
    );
    s.run(&["setup", "--strategy", "sideways"]).fails(
        1,
        "--strategy takes reset-first, fill-first, least-used, or round-robin",
    );
    s.run(&["setup", "--affinity", "maybe"])
        .fails(1, "expected on or off, got \"maybe\"");
    s.run(&["setup", "--login", "xai"])
        .fails(1, "--login signs in to subscriptions (claude, codex)");
    s.run(&["setup", "--agents", "grok"])
        .fails(1, "unknown agent \"grok\"");
    s.run(&["setup", "--import", "dropbox"])
        .fails(1, "unknown source \"dropbox\"");
    assert!(s.store().list().unwrap().is_empty());
    assert_eq!(s.stub_calls(), "");
}

#[test]
fn unattended_setup_imports_routes_wires_and_starts_the_proxy() {
    let s = Sandbox::new("init-run");
    write(
        &s.home.join(".cli-proxy-api/codex-a.json"),
        &json!({"type": "codex", "access_token": "tok-a", "refresh_token": "ref-a",
                "email": "a@x.dev", "account_id": "ws-a"})
        .to_string(),
    );
    // Codex points elsewhere now, and is left alone: only Claude Code is
    // asked for.
    let elsewhere = "model_provider = \"other\"\n[model_providers.other]\nbase_url = \"https://o.example/v1\"\n";
    write(&s.codex.join("config.toml"), elsewhere);

    let out = s
        .run(&[
            "setup",
            "--yes",
            "--import",
            "cliproxyapi",
            "--strategy",
            "round-robin",
            "--affinity",
            "off",
            "--agents",
            "claude",
        ])
        .ok();
    let text = &out.stdout;
    for step in ["Accounts", "Routing", "Agents", "Background"] {
        assert!(text.contains(step), "{step}: {text}");
    }
    assert!(text.contains("+ a@x.dev"), "{text}");
    assert!(
        text.contains("routing: round-robin, every request placed afresh"),
        "{text}"
    );
    assert!(text.contains("wired"), "{text}");
    assert!(text.contains("No login service here"), "{text}");
    assert!(!text.contains("Start slopmax at login?"), "{text}");
    assert!(text.contains("The proxy is running on"), "{text}");
    assert!(text.contains("Done."), "{text}");

    assert_eq!(s.store().list().unwrap().len(), 1);
    let config = std::fs::read_to_string(s.config()).unwrap();
    assert!(config.contains("strategy = \"round-robin\""), "{config}");
    assert!(config.contains("session_affinity = false"), "{config}");
    let settings = std::fs::read_to_string(s.claude.join("settings.json")).unwrap();
    assert!(
        settings.contains(&format!("127.0.0.1:{}", s.port)),
        "{settings}"
    );
    assert_eq!(
        std::fs::read_to_string(s.codex.join("config.toml")).unwrap(),
        elsewhere
    );

    // Again, with stdin not a terminal (so nothing is asked) and the
    // `init` alias: what is done is noticed, and Codex is wired this time.
    let out = s
        .run(&["init", "--import", "none", "--agents", "claude,codex"])
        .ok();
    let text = &out.stdout;
    assert!(text.contains("Claude Code already uses slopmax."), "{text}");
    assert!(
        text.contains("routing: round-robin, every request placed afresh"),
        "{text}"
    );
    assert!(text.contains("The proxy is running on"), "{text}");
    let toml = std::fs::read_to_string(s.codex.join("config.toml")).unwrap();
    assert!(toml.contains(&format!("127.0.0.1:{}", s.port)), "{toml}");
    assert_eq!(s.store().list().unwrap().len(), 1);
    assert_eq!(s.stub_calls(), "");

    // Claude Code was wired by name with no Claude account to serve it:
    // the doctor says so.
    let doctor = s.run(&["doctor"]);
    assert!(
        doctor
            .stdout
            .contains("points at slopmax, but no Claude account is connected"),
        "{doctor:?}"
    );

    let out = s.run(&["stop"]).ok();
    assert!(out.stdout.contains("slopmax stopped"), "{out:?}");
}

#[test]
fn unattended_setup_leaves_alone_an_agent_it_has_no_account_for() {
    let s = Sandbox::new("init-unserved");
    write(
        &s.home.join(".cli-proxy-api/codex-a.json"),
        &json!({"type": "codex", "access_token": "tok-a", "refresh_token": "ref-a",
                "email": "a@x.dev", "account_id": "ws-a"})
        .to_string(),
    );
    let out = s
        .run(&["setup", "--yes", "--import", "cliproxyapi", "--no-service"])
        .ok();
    let text = &out.stdout;
    assert!(
        text.contains("Claude Code left as it is: no Claude account to serve it."),
        "{text}"
    );
    assert!(text.contains("1 account behind"), "{text}");
    // Claude Code keeps working as it did; Codex goes through slopmax.
    assert!(!s.claude.join("settings.json").exists());
    let toml = std::fs::read_to_string(s.codex.join("config.toml")).unwrap();
    assert!(toml.contains(&format!("127.0.0.1:{}", s.port)), "{toml}");
    s.run(&["stop"]).ok();
}

#[test]
fn unattended_setup_that_misses_part_of_what_was_asked_says_so() {
    let s = Sandbox::new("init-partial");
    write(
        &s.home.join(".cli-proxy-api/codex-a.json"),
        &json!({"type": "codex", "access_token": "tok-a", "refresh_token": "ref-a",
                "email": "a@x.dev", "account_id": "ws-a"})
        .to_string(),
    );
    // CLIProxyAPI has a login; Codex's own home has none.
    let out = s.run(&[
        "setup",
        "--yes",
        "--import",
        "cliproxyapi,codex",
        "--agents",
        "none",
        "--no-service",
    ]);
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stdout.contains("Done."),
        "the rest went through: {out:?}"
    );
    assert!(
        out.stderr.contains("--import codex found no login to take"),
        "{out:?}"
    );
    assert_eq!(s.store().list().unwrap().len(), 1);
    s.run(&["stop"]).ok();
}
