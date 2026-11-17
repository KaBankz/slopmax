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
    // This host may have the real one on PATH: no test may run it.
    "tailscale",
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
        Self::under(&std::env::temp_dir(), name)
    }

    /// A sandbox whose paths are short enough for the tailnet socket
    /// (macOS's temp dir is long).
    #[cfg(unix)]
    fn short(name: &str) -> Self {
        Self::under(Path::new("/tmp"), name)
    }

    fn under(dir: &Path, name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = dir.join(format!("slopmax-cli-{name}-{}-{nanos}", std::process::id()));
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
            // The stub, or the fake that tests write over it; Windows can't
            // run either, so there Tailscale isn't installed.
            .env(
                "SLOPMAX_TAILSCALE",
                if cfg!(windows) {
                    PathBuf::new()
                } else {
                    self.stubs.join("tailscale")
                },
            )
            .env("FAKE_TS", self.root.join("ts"))
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

    /// Fails if anything ran a `tailscale` command that changes Tailscale
    /// itself, which slopmax never does.
    #[track_caller]
    fn assert_no_mutating_tailscale(&self) {
        let log = self.stub_calls();
        for line in log.lines().filter(|l| l.starts_with("tailscale ")) {
            let mutating = [" set", " up", " down", "funnel", "serve reset"]
                .iter()
                .any(|word| line.contains(word));
            assert!(!mutating, "slopmax ran `{line}`:\n{log}");
        }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // A proxy left by a failed test would outlive it.
        let _ = self.command(&["proxy", "stop"]).output();
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
    assert!(help.stdout.contains("Pool your"), "{help:?}");
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
        let script = s.run(&["completion", shell]).ok();
        assert!(script.stdout.contains("slopmax"), "{shell}: {script:?}");
    }
}

#[test]
fn mistakes_explain_themselves_and_fail() {
    let s = Sandbox::new("mistakes");
    // The parser's errors exit 2 with a hint.
    s.run(&["statsu"]).fails(2, "status");
    s.run(&["account", "rename"]).fails(2, "<ACCOUNT>");
    s.run(&["completion", "tcsh"]).fails(2, "tcsh");
    s.run(&["status", "--frobnicate"]).fails(2, "--frobnicate");
    s.run(&["status", "--watch", "--json"])
        .fails(2, "'--watch' cannot be used with '--json'");
    s.run(&["usage", "--by", "week"])
        .fails(2, "[possible values: day, model, account, machine]");
    s.run(&["usage", "fortnight"]).fails(2, "fortnight");
    s.run(&["proxy", "logs", "-n", "many"])
        .fails(2, "invalid value 'many' for '--lines'");
    s.run(&["key", "add"]).fails(2, "<NAME>");
    s.run(&[
        "login",
        "compat",
        "--url",
        "http://h/v1",
        "--dialect",
        "soap",
    ])
    .fails(2, "[possible values: chat, responses, messages]");
    s.run(&["account", "priority", "x", "high"])
        .fails(2, "invalid value 'high' for '<TIER>'");
    s.run(&["account", "import", "nowhere"]).fails(2, "nowhere");
    s.run(&["account", "use"]).fails(2, "[ACCOUNT]");
    // Commands that moved fail with their new spelling.
    s.run(&["label", "1", "work"])
        .fails(2, "`slopmax label` is now `slopmax account rename`");
    s.run(&["start"]).fails(2, "is now `slopmax proxy start`");
    s.run(&["service", "install"])
        .fails(2, "is now `slopmax proxy install`");

    // The commands' own checks exit 1.
    s.run(&["key", "remove", "ghost"])
        .fails(1, "no key named \"ghost\"");
    s.run(&["login", "compat"]).fails(1, "--url <base url>");
    s.run(&["login", "claude", "--url", "http://localhost:1/v1"])
        .fails(1, "are for `slopmax login compat`");
    s.run(&["login", "compat", "--url", "ftp://host"])
        .fails(1, "http:// or https://");
    s.run(&["login", "claude", "--device"])
        .fails(1, "--device works for ChatGPT and SuperGrok accounts");
    s.run(&["notify", "test"]).fails(1, "notifications are off");
    s.run(&["account", "rename", "1", "work"])
        .fails(1, "no account matches \"1\"");
    s.run(&["agent", "disconnect", "claude"])
        .fails(1, "no Claude Code setup to undo");
    s.run(&["account", "check", "1"])
        .fails(1, "the proxy isn't running");

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

    let table = s.run(&["status"]).ok().stdout;
    assert!(table.contains("CLAUDE"), "{table}");
    assert!(table.contains("CODEX"), "{table}");
    assert!(table.contains("a@x.dev"), "{table}");
    assert!(table.contains("max 20x"), "{table}");
    // Without a terminal, a bare `slopmax` is `status`.
    assert_eq!(s.run(&[]).ok().stdout, table);

    // `account list` numbers them as every <ACCOUNT> does.
    let list = s.run(&["account", "list"]).ok().stdout;
    assert!(list.contains("  1  a@x.dev"), "{list}");
    assert_eq!(s.run(&["account"]).ok().stdout, list);
    let listed: Value =
        serde_json::from_str(&s.run(&["account", "list", "--json"]).ok().stdout).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 4, "{listed:#}");
}

#[test]
fn every_listing_prints_json() {
    let s = Sandbox::new("json");
    s.add(&claude("a@x.dev"));
    for args in [
        &["agent", "list", "--json"][..],
        &["key", "list", "--json"][..],
        &["proxy", "status", "--json"][..],
        &["config", "--json"][..],
        &["config", "strategy", "--json"][..],
        &["requests", "--json"][..],
        &["usage", "--json"][..],
        &["tailscale", "status", "--json"][..],
        &["tailscale", "user", "--json"][..],
        &["tailscale", "admin", "list", "--json"][..],
        &["account", "--json"][..],
        &["account", "order", "--json"][..],
        &["agent", "--json"][..],
        &["key", "--json"][..],
        &["proxy", "--json"][..],
        &["notify", "--json"][..],
        &["config", "listen", "--json"][..],
    ] {
        let out = s.run(args);
        assert!(
            serde_json::from_str::<Value>(&out.stdout).is_ok(),
            "{args:?}: {out:?}"
        );
    }
    let agents: Value =
        serde_json::from_str(&s.run(&["agent", "list", "--json"]).ok().stdout).unwrap();
    assert_eq!(agents.as_array().unwrap().len(), 3, "{agents:#}");
    let proxy: Value =
        serde_json::from_str(&s.run(&["proxy", "status", "--json"]).ok().stdout).unwrap();
    assert_eq!(proxy["running"], false, "{proxy:#}");
    assert_eq!(proxy["state"], "stopped", "{proxy:#}");
    // Settings come keyed as `config` takes them, with typed values.
    let config: Value = serde_json::from_str(&s.run(&["config", "--json"]).ok().stdout).unwrap();
    assert_eq!(config["strategy"], "fill-first", "{config:#}");
    assert!(config["listen"].is_string(), "{config:#}");
    assert!(config["websockets"].is_boolean(), "{config:#}");
    let order: Value =
        serde_json::from_str(&s.run(&["account", "order", "--json"]).ok().stdout).unwrap();
    assert_eq!(order[0]["accounts"][0]["number"], 1, "{order:#}");
    // Forgetting an account asks first; without a terminal, it takes --yes.
    s.run(&["account", "remove", "1"]).fails(1, "Pass --yes");
    assert_eq!(s.store().list().unwrap().len(), 1);
    let doctor = s.run(&["doctor", "--json"]);
    let sections: Value = serde_json::from_str(&doctor.stdout).unwrap();
    assert!(
        sections.as_array().is_some_and(|s| !s.is_empty()),
        "{doctor:?}"
    );
}

#[test]
fn the_usage_spec_describes_every_command() {
    let s = Sandbox::new("spec");
    let spec = s.run(&["__usage_spec__"]).ok().stdout;
    for command in [
        "cmd account",
        "cmd agent",
        "cmd proxy",
        "cmd key",
        "cmd tailscale",
    ] {
        assert!(spec.contains(command), "{command}: {spec}");
    }
    assert!(spec.contains("effect=destructive"), "{spec}");
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

    let out = s.run(&["account", "rename", "a@x.dev", "work"]).ok();
    assert!(out.stdout.contains("work"), "{out:?}");
    assert_eq!(s.account(&a.id).label.as_deref(), Some("work"));

    let out = s.run(&["account", "priority", "work", "-2"]).ok();
    assert!(out.stdout.contains("priority -2"), "{out:?}");
    assert_eq!(s.account(&a.id).priority, -2);

    s.run(&["account", "disable", "work"]).ok();
    assert!(s.account(&a.id).disabled);
    let out = s.run(&["account", "enable", &a.id]).ok();
    assert!(out.stdout.contains("Enabled work"), "{out:?}");
    assert!(!s.account(&a.id).disabled);

    // With no daemon running, `use` writes the pins into state.toml itself.
    let state = s.slopmax.join("state.toml");
    let pins = |state: &std::path::Path| -> toml_edit::Item {
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(state).unwrap().parse().unwrap();
        doc.get("pins").cloned().unwrap_or(toml_edit::Item::None)
    };
    let out = s.run(&["account", "use", "b@x.dev"]).ok();
    assert!(
        out.stdout
            .contains("New Claude sessions will use b@x.dev while it has quota."),
        "{out:?}"
    );
    assert_eq!(pins(&state)["claude"].as_str(), Some(b.id.as_str()));
    let out = s.run(&["account", "use", "--auto"]).ok();
    assert!(out.stdout.contains("automatically"), "{out:?}");
    assert!(pins(&state).get("claude").is_none());

    // Removing a pinned account drops its pin too.
    s.run(&["account", "use", "b@x.dev"]).ok();
    let out = s.run(&["account", "remove", "b@x.dev", "--yes"]).ok();
    assert!(out.stdout.contains("Removed b@x.dev"), "{out:?}");
    assert!(s.store().get(&b.id).unwrap().is_none());
    assert!(pins(&state).get("claude").is_none());

    // Ambiguous and missing references are refused; the ambiguous ones
    // are named by the numbers `status` shows.
    s.add(&claude("c@x.dev"));
    let numbered = s.store().list().unwrap();
    let out = s
        .run(&["account", "remove", "claude-", "--yes"])
        .fails(1, "\"claude-\" matches 2 accounts: #1 ");
    for (n, account) in numbered.iter().enumerate() {
        let named = format!("#{} {} ({})", n + 1, account.name(), account.id);
        assert!(out.stderr.contains(&named), "{named}: {out:?}");
    }
    assert!(
        out.stderr.contains("e.g. `slopmax account use 1`"),
        "{out:?}"
    );
    s.run(&["account", "disable", "nobody"])
        .fails(1, "no account matches");

    // A label another account goes by would name two; it is refused.
    s.run(&["account", "rename", "c@x.dev", "work"])
        .fails(1, "\"work\" is already the label of #");
    s.run(&["account", "rename", "c@x.dev", "a@x.dev"])
        .fails(1, "\"a@x.dev\" is already the email of #");
    assert_eq!(s.account("c@x.dev").label, None);
    // Giving an account its own label again is fine.
    s.run(&["account", "rename", "work", "work"]).ok();

    // A disabled account is not used, so `use` says so instead.
    s.run(&["account", "disable", "c@x.dev"]).ok();
    s.run(&["account", "use", "c@x.dev"]).fails(
        1,
        "c@x.dev is disabled, so it won't be used; run `slopmax account enable c@x.dev` first",
    );
    assert!(pins(&state).get("claude").is_none());
    // A key has no quota to run out of.
    let openai = key(ProviderId::OpenAI, "sk-openai-1234");
    s.add(&openai);
    let out = s.run(&["account", "use", &openai.id]).ok();
    assert!(
        out.stdout
            .contains("New OpenAI API sessions will use OpenAI API key …1234.\n"),
        "{out:?}"
    );
}

#[test]
fn own_takes_over_linked_accounts() {
    let s = Sandbox::new("own");
    let out = s.run(&["account", "adopt", "all"]).ok();
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

    let out = s.run(&["account", "adopt", "m@x.dev"]).ok();
    assert!(out.stdout.contains("already refreshes here"), "{out:?}");
    // Nothing changed hands, so there is nothing to warn about.
    assert!(!out.stdout.contains("first refresh"), "{out:?}");
    let openai = key(ProviderId::OpenAI, "sk-openai-1234");
    s.add(&openai);
    let out = s.run(&["account", "adopt", &openai.id]).ok();
    assert_eq!(
        out.stdout,
        "OpenAI API key …1234 uses an API key; there's nothing to take over.\n"
    );
    let out = s.run(&["account", "adopt", "all"]).ok();
    assert!(
        out.stdout.contains("slopmax now refreshes l@x.dev"),
        "{out:?}"
    );
    assert!(out.stdout.contains("was following cliproxyapi"), "{out:?}");
    assert!(out.stdout.contains("first refresh signs the old copy out"));
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

    // Revoking asks first; without a terminal to ask at, it takes --yes.
    s.run(&["key", "remove", "laptop"]).fails(1, "Pass --yes");
    let out = s.run(&["key", "remove", "laptop", "--yes"]).ok();
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
        machine: None,
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
    // A row of only failed requests would be all zeros, so it is left out.
    write_ledger(&s, &[entry(now, "", "claude-sonnet-4-6", 503)]);
    let accounts = s.run(&["usage", "today", "--by", "account"]).ok().stdout;
    assert!(accounts.contains("a@x.dev"), "{accounts}");
    assert!(accounts.contains("2 requests failed"), "{accounts}");
    let rows: Vec<&str> = accounts
        .lines()
        .skip_while(|l| !l.contains("ACCOUNT"))
        .skip(1)
        .take_while(|l| !l.starts_with("total"))
        .collect();
    assert_eq!(rows.len(), 1, "{accounts}");
    // Requests another machine sent are its; this one's own read as such.
    let mut sent = entry(now, &a.id, "claude-sonnet-4-6", 200);
    sent.machine = Some("laptop".into());
    write_ledger(&s, &[sent]);
    let machines = s.run(&["usage", "today", "--by", "machine"]).ok().stdout;
    assert!(machines.contains("MACHINE"), "{machines}");
    assert!(machines.contains("this machine"), "{machines}");
    assert!(machines.contains("laptop"), "{machines}");

    // With nothing but failures, it says so rather than show zeros.
    let s = Sandbox::new("usage-failed");
    let now = Timestamp::now();
    write_ledger(
        &s,
        &[
            entry(now, "", "claude-sonnet-4-6", 503),
            entry(now, "", "claude-sonnet-4-6", 529),
        ],
    );
    let out = s.run(&["usage"]).ok();
    assert_eq!(
        out.stdout,
        "No successful requests in the last 7 days; 2 failed (see `slopmax proxy logs`).\n"
    );
    let out = s.run(&["usage", "today"]).ok();
    assert!(
        out.stdout.starts_with("No successful requests today;"),
        "{out:?}"
    );
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
    let out = s.run(&["agent", "connect", "claude"]).ok();
    assert!(
        out.stdout.contains("Claude Code now uses slopmax"),
        "{out:?}"
    );
    // How to undo it, as a command that runs.
    assert!(
        out.stdout
            .contains("Undo with `slopmax agent disconnect claude`."),
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

    let out = s.run(&["agent", "connect", "codex"]).ok();
    assert!(out.stdout.contains("Codex now uses slopmax"), "{out:?}");
    let wired_toml = std::fs::read_to_string(&toml).unwrap();
    assert!(wired_toml.contains(&base), "{wired_toml}");
    assert!(wired_toml.contains("# mine"), "{wired_toml}");

    // Setting up twice keeps the first backup, so undo still restores the
    // original.
    s.run(&["agent", "connect", "claude"]).ok();
    s.run(&["agent", "connect", "codex"]).ok();

    let doctor = s.run(&["doctor"]).stdout;
    assert!(doctor.contains("Claude Code"), "{doctor}");

    let out = s.run(&["agent", "disconnect", "claude"]).ok();
    assert!(out.stdout.contains("Restored Claude Code"), "{out:?}");
    let restored: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    let original: Value = serde_json::from_str(original_settings).unwrap();
    assert_eq!(restored, original);

    let out = s.run(&["agent", "disconnect", "codex"]).ok();
    assert!(out.stdout.contains("Restored Codex"), "{out:?}");
    let restored_toml = std::fs::read_to_string(&toml).unwrap();
    assert_eq!(restored_toml, original_toml);

    s.run(&["agent", "disconnect", "codex"])
        .fails(1, "no Codex setup to undo");
}

#[test]
fn setup_on_a_fresh_machine_and_undo_leave_no_wiring() {
    let s = Sandbox::new("fresh-setup");
    s.run(&["agent", "connect", "claude"]).ok();
    s.run(&["agent", "connect", "codex"]).ok();
    let settings = s.claude.join("settings.json");
    let toml = s.codex.join("config.toml");
    assert!(settings.is_file());
    assert!(toml.is_file());

    s.run(&["agent", "disconnect", "claude"]).ok();
    s.run(&["agent", "disconnect", "codex"]).ok();
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
    let claude = s.run(&["agent", "env", "claude"]).ok().stdout;
    assert!(claude.contains("ANTHROPIC_BASE_URL"), "{claude}");
    assert!(claude.contains(&base), "{claude}");
    let codex = s.run(&["agent", "env", "codex"]).ok().stdout;
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
    let out = s.run(&["account", "import"]).ok();
    // Where it looked, so a login kept elsewhere can be found.
    assert!(
        out.stdout.contains("No logins found to import. Looked in "),
        "{out:?}"
    );
    assert!(out.stdout.contains("auth.json"), "{out:?}");
    assert!(out.stdout.contains(".cli-proxy-api"), "{out:?}");
    let out = s.run(&["account", "import", "codex"]).ok();
    assert_eq!(
        out.stdout,
        format!(
            "No logins found to import. Looked in {}.\n",
            s.codex.join("auth.json").display()
        )
    );
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

    let out = s.run(&["account", "import"]).ok();
    let text = &out.stdout;
    assert!(text.contains("skipped"), "{text}");
    assert!(text.contains("login has expired"), "{text}");
    assert!(text.contains("no access token"), "{text}");
    // A file that is no login is reported, once, by where it is.
    let broken = format!(
        "skipped ~{0}.cli-proxy-api{0}broken.json: not a CLIProxyAPI login file\n",
        std::path::MAIN_SEPARATOR
    );
    assert!(text.contains(&broken), "{text}");
    assert!(!text.contains("gemini"), "{text}");
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

    // Importing again updates the same accounts; --adopt stops following.
    let out = s.run(&["account", "import", "cliproxyapi", "--adopt"]).ok();
    assert!(out.stdout.contains('~'), "{out:?}");
    assert!(!out.stdout.contains("linked:"), "{out:?}");
    assert_eq!(s.store().list().unwrap().len(), 3);
    assert!(s.account("cpa-a").link.is_none());

    let out = s.run(&["account", "import", "codex"]).ok();
    assert!(out.stdout.contains("auth.json"), "{out:?}");
    assert!(
        !s.stub_calls().contains("security"),
        "the keychain was consulted: {}",
        s.stub_calls()
    );

    // Unreadable logins say what they are not and what to run, without
    // the parser's words or the path twice.
    write(
        &s.codex.join("auth.json"),
        r#"{"tokens": {"id_token": "x"}}"#,
    );
    write(&s.claude.join(".credentials.json"), "{bad");
    let out = s.run(&["account", "import", "codex"]).ok();
    let codex_file = s.codex.join("auth.json").display().to_string();
    assert_eq!(
        out.stdout,
        format!(
            "  skipped {codex_file}: not a signed-in Codex login. Run `codex login`, then import again.\n"
        )
    );
    let out = s.run(&["account", "import", "claude-code"]).ok();
    assert!(
        out.stdout
            .contains(".credentials.json: not a signed-in Claude Code login."),
        "{out:?}"
    );

    // Logins with no email are still told apart.
    for name in ["x", "y"] {
        write(
            &cpa.join(format!("claude-{name}.json")),
            &json!({"type": "claude", "access_token": format!("tok-{name}"), "email": ""})
                .to_string(),
        );
    }
    let before = s.store().list().unwrap().len();
    s.run(&["account", "import", "cliproxyapi"]).ok();
    let accounts = s.store().list().unwrap();
    assert_eq!(accounts.len(), before + 2, "{accounts:#?}");
    assert!(accounts.iter().all(|a| a.id != "claude-e3b0c442"));
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
    assert_eq!(
        out.stdout,
        "Updated box (same endpoint and key): now serves qwen3\n"
    );

    // An endpoint that doesn't answer is kept, and the person is told.
    let out = run(
        vec![
            "login".into(),
            "compat".into(),
            "--url".into(),
            "http://127.0.0.1:9/v1".into(),
            "--models".into(),
            "m3".into(),
        ],
        "",
    )
    .await
    .unwrap()
    .ok();
    assert!(
        out.stdout.contains(
            "Saved, but http://127.0.0.1:9/v1 didn't answer: couldn't connect to 127.0.0.1:9 (connection refused); requests will fail until it does."
        ),
        "{out:?}"
    );
    // A label another account has is refused.
    let out = run(
        vec![
            "login".into(),
            "compat".into(),
            "--url".into(),
            "http://127.0.0.1:9/v2".into(),
            "--models".into(),
            "m3".into(),
            "--label".into(),
            "box".into(),
        ],
        "",
    )
    .await
    .unwrap();
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr.contains("\"box\" is already the label of #"),
        "{out:?}"
    );

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
    s.run(&["account", "redeem", "1", "--yes"])
        .fails(1, "has no limit resets");
    // Listing a ChatGPT account's resets needs the network.
    s.add(&codex("b@x.dev"));
    s.run(&["account", "redeem", "b@x.dev", "--yes"])
        .fails(1, "error:");
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
    let out = s.run(&["notify", "test"]).ok();
    assert!(out.stdout.contains("Sent a test notification"), "{out:?}");
    assert_eq!(std::fs::read_to_string(&sent).unwrap(), "test");
}

// The commands run in a POSIX shell.
#[cfg(unix)]
#[test]
fn notify_failures_say_what_happened() {
    let s = Sandbox::new("notify-fails");
    s.run(&["key", "list"]).ok();
    let base = std::fs::read_to_string(s.config()).unwrap();
    let with =
        |notify: &str| std::fs::write(s.config(), format!("{base}\n[notify]\n{notify}\n")).unwrap();
    with("command = 'exit 3'");
    s.run(&["notify", "test"])
        .fails(1, "error: the notify command exited with 3 (no output)\n");
    with("command = 'nonexistent-cmd-xyz'");
    let out = s
        .run(&["notify", "test"])
        .fails(1, "error: the notify command exited with 127: ");
    assert!(out.stderr.contains("nonexistent-cmd-xyz"), "{out:?}");
    // A webhook that is no address is a config error, named, at once.
    with("webhook = 'not a url'");
    s.run(&["status"]).fails(
        1,
        "[notify] webhook = \"not a url\" is not a web address; give the whole URL, starting with https://",
    );
}

#[test]
fn config_speaks_in_the_names_it_takes() {
    let s = Sandbox::new("config");
    s.run(&["config", "poll_mins", "99999999999999999999"])
        .fails(1, "error: poll_mins is a number of minutes\n");
    s.run(&["config", "session_ttl_mins", "0"]).fails(
        1,
        "error: session_ttl_mins is a number of minutes, at least 1\n",
    );
    let out = s
        .run(&["config", "bogus", "1"])
        .fails(1, "bogus is not a setting slopmax changes while it runs; those are strategy, session_affinity, session_ttl_mins,");
    assert!(out.stderr.contains("websockets"), "{out:?}");
    // Every live setting, whether or not the proxy runs.
    let out = s.run(&["config", "websockets", "off"]).ok();
    assert!(out.stdout.contains("websockets = false"), "{out:?}");
    assert_eq!(s.run(&["config", "websockets"]).ok().stdout, "false\n");
    assert!(s.run(&["config"]).ok().stdout.contains("refresh_tokens"));
    // `listen` is shown with how to change it.
    let out = s.run(&["config", "listen"]).ok();
    assert!(
        out.stdout
            .contains(&format!("listen = 127.0.0.1:{}", s.port)),
        "{out:?}"
    );
    assert!(
        out.stdout.contains("restart the proxy after changing it"),
        "{out:?}"
    );
    s.run(&["config", "listen", "1.2.3.4:9"])
        .fails(1, "`slopmax config` can't change listen");
}

#[test]
fn a_sign_in_that_needs_a_paste_needs_a_terminal() {
    let s = Sandbox::new("no-terminal");
    let out = s.run(&["login", "claude", "--no-browser"]).fails(
        1,
        "slopmax login claude needs a terminal to paste the code into; run it in an interactive shell, or bring an existing login over with `slopmax account import claude-code`",
    );
    // Refused before any link is shown.
    assert!(!out.stdout.contains("http"), "{out:?}");
    assert!(!out.stderr.contains("https://"), "{out:?}");
}

#[test]
fn signed_out_accounts_say_how_to_sign_in() {
    let s = Sandbox::new("signed-out");
    let mut a = claude("a@x.dev");
    a.auth_error = Some("refresh token rejected (401 Unauthorized)".into());
    s.add(&a);
    let table = s.run(&["status"]).ok().stdout;
    assert!(
        table.contains("signed out: run `slopmax login claude`"),
        "{table}"
    );
    assert!(!table.contains("(401"), "{table}");
    // The detail stays in the JSON and the doctor.
    let json = s.run(&["status", "--json"]).ok().stdout;
    assert!(
        json.contains("refresh token rejected (401 Unauthorized)"),
        "{json}"
    );
}

#[test]
fn logs_show_the_tail_of_the_background_log() {
    let s = Sandbox::new("logs");
    let out = s.run(&["proxy", "logs"]).ok();
    assert!(out.stdout.contains("No log yet"), "{out:?}");
    let lines: String = (1..=50).map(|n| format!("line {n}\n")).collect();
    write(&s.slopmax.join("slopmax.log"), &lines);
    let out = s.run(&["proxy", "logs", "-n", "3"]).ok();
    assert_eq!(out.stdout, "line 48\nline 49\nline 50\n");
    let out = s.run(&["proxy", "logs"]).ok();
    assert_eq!(out.stdout.lines().count(), 40);
    assert!(out.stdout.starts_with("line 11\n"), "{out:?}");
}

#[test]
fn order_shows_and_sets_the_order_new_sessions_use() {
    let s = Sandbox::new("order");
    let out = s.run(&["account", "order"]).ok();
    assert!(out.stdout.contains("No accounts yet"), "{out:?}");
    for email in ["a@x.dev", "b@x.dev", "c@x.dev"] {
        s.add(&claude(email));
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    s.add(&codex("d@x.dev"));
    let emails = || -> Vec<String> {
        let accounts = s.store().list().unwrap();
        accounts.iter().filter_map(|a| a.email.clone()).collect()
    };
    assert_eq!(emails(), ["a@x.dev", "b@x.dev", "c@x.dev", "d@x.dev"]);

    let out = s.run(&["account", "order"]).ok();
    assert!(
        out.stdout.contains("Claude accounts, in the order"),
        "{out:?}"
    );
    assert!(out.stdout.contains("ChatGPT"), "{out:?}");

    // Numbers as `order` lists them; the rest keep their order after.
    let out = s.run(&["account", "order", "3", "b@x.dev"]).ok();
    assert_eq!(emails(), ["c@x.dev", "b@x.dev", "a@x.dev", "d@x.dev"]);
    let listed: Vec<&str> = out
        .stdout
        .lines()
        .filter(|l| l.contains("@x.dev"))
        .collect();
    assert!(
        listed[0].contains("c@x.dev") && listed[2].contains("a@x.dev"),
        "{out:?}"
    );
    assert!(
        !out.stdout.contains("d@x.dev"),
        "only the kind ordered: {out:?}"
    );

    s.run(&["account", "order", "1", "d@x.dev"])
        .fails(1, "order one kind at a time");
    s.run(&["account", "order", "1", "1"])
        .fails(1, "listed twice");
    s.run(&["account", "priority", "a@x.dev", "1"]).ok();
    s.run(&["account", "order", "c@x.dev", "a@x.dev"])
        .fails(1, "slopmax account priority");
    s.run(&["account", "order", "nobody"])
        .fails(1, "no account matches");

    // Under another strategy, it says the order is not what places sessions.
    std::fs::write(s.config(), "strategy = \"least-used\"\n").unwrap();
    let out = s.run(&["account", "order"]).ok();
    assert!(out.stdout.contains("strategy fill-first"), "{out:?}");
}

#[test]
fn the_background_proxy_starts_reports_and_stops() {
    let s = Sandbox::new("background");
    s.add(&key(ProviderId::Anthropic, "sk-ant-9999"));
    s.add(&key(ProviderId::Anthropic, "sk-ant-8888"));
    let out = s.run(&["proxy", "stop"]).ok();
    assert!(out.stdout.contains("slopmax is not running"), "{out:?}");

    let out = s.run(&["proxy", "start"]).ok();
    assert!(out.stdout.contains("slopmax running on"), "{out:?}");
    let out = s.run(&["proxy", "start"]).ok();
    assert!(out.stdout.contains("already running"), "{out:?}");
    let before: Value =
        serde_json::from_str(&s.run(&["proxy", "status", "--json"]).ok().stdout).unwrap();
    assert_eq!(before["state"], "running", "{before:#}");
    // A restart leaves a new process serving.
    let out = s.run(&["proxy", "restart"]).ok();
    assert!(
        out.stdout.contains("restarted on") || out.stdout.contains("slopmax running on"),
        "{out:?}"
    );
    let after: Value =
        serde_json::from_str(&s.run(&["proxy", "status", "--json"]).ok().stdout).unwrap();
    assert_eq!(after["running"], true, "{after:#}");
    assert_ne!(after["pid"], before["pid"], "{before:#} {after:#}");

    // The status now comes from the proxy.
    let json: Value = serde_json::from_str(&s.run(&["status", "--json"]).ok().stdout).unwrap();
    assert_eq!(json["accounts"].as_array().unwrap().len(), 2, "{json:#}");
    let table = s.run(&["status", "--refresh"]).ok().stdout;
    assert!(table.contains("ANTHROPIC"), "{table}");

    // With it running, changes go through it rather than into the files.
    let id = s.store().list().unwrap()[0].id.clone();
    let out = s.run(&["account", "use", &id]).ok();
    assert!(out.stdout.contains("will use"), "{out:?}");
    let out = s.run(&["account", "rename", &id, "work"]).ok();
    assert!(out.stdout.contains("work"), "{out:?}");
    let out = s.run(&["config", "session_ttl_mins", "45"]).ok();
    assert!(out.stdout.contains("applied now"), "{out:?}");
    // Through the proxy too, settings are named as they were typed.
    let out = s
        .run(&["config", "poll_mins", "99999999999999999999"])
        .fails(1, "poll_mins is a number of minutes");
    assert!(!out.stderr.contains("pollMinutes"), "{out:?}");
    s.run(&["config", "session_ttl_mins", "0"])
        .fails(1, "session_ttl_mins is a number of minutes, at least 1");
    let out = s
        .run(&["config", "listen", "1.2.3.4:9"])
        .fails(1, "`slopmax config` can't change listen");
    assert!(!out.stderr.contains("sessionAffinity"), "{out:?}");
    let out = s.run(&["config", "websockets", "off"]).ok();
    assert!(out.stdout.contains("websockets = false"), "{out:?}");
    // An endpoint added through the proxy that doesn't answer says so.
    let out = s
        .run_with(
            &[
                "login",
                "compat",
                "--url",
                "http://127.0.0.1:9/v1",
                "--models",
                "m3",
            ],
            "",
        )
        .ok();
    assert!(
        out.stdout
            .contains("Saved, but http://127.0.0.1:9/v1 didn't answer"),
        "{out:?}"
    );
    let out = s
        .run_with(
            &[
                "login",
                "compat",
                "--url",
                "http://127.0.0.1:9/v1",
                "--models",
                "m4",
            ],
            "",
        )
        .ok();
    assert!(
        out.stdout
            .contains("(same endpoint and key): now serves m4"),
        "{out:?}"
    );
    let compat = s
        .store()
        .list()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == ProviderId::Compat)
        .unwrap();
    s.run(&["account", "remove", &compat.id, "--yes"]).ok();
    let key = s.run(&["key", "add", "laptop"]).ok().stdout;
    assert!(key.trim().starts_with("sm-"), "{key}");
    let json: Value = serde_json::from_str(&s.run(&["status", "--json"]).ok().stdout).unwrap();
    let account = &json["accounts"][0];
    assert_eq!(account["name"], "work", "{json:#}");
    assert_eq!(account["pinned"], true, "{json:#}");
    // The order too, which the daemon saves and the next status shows.
    s.run(&["account", "order", "anthropic-"])
        .fails(1, "\"anthropic-\" matches 2 accounts: #1 work");
    let second = s.store().list().unwrap()[1].id.clone();
    s.run(&["account", "order", &second]).ok();
    let json: Value = serde_json::from_str(&s.run(&["status", "--json"]).ok().stdout).unwrap();
    assert_eq!(json["accounts"][0]["id"], second.as_str(), "{json:#}");
    assert_eq!(s.store().list().unwrap()[0].id, second);
    // The daemon saves the pin it was told of at once.
    eventually("the daemon saves the pin", || {
        std::fs::read_to_string(s.slopmax.join("state.toml"))
            .unwrap_or_default()
            .contains(&format!("anthropic = \"{id}\""))
    });

    let out = s.run(&["dashboard", "--no-browser"]).ok();
    assert!(
        out.stdout.contains(&format!("127.0.0.1:{}", s.port)),
        "{out:?}"
    );
    assert!(out.stdout.contains("ssh -L"), "{out:?}");
    // Without --no-browser it asks the system to open it (a stub here).
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
    s.run(&["run", "codex", "exec", "hi"]).fails(
        1,
        "`codex` isn't installed or isn't on PATH. Install Codex, then run `slopmax run codex` again.",
    );

    let out = s.run(&["proxy", "stop"]).ok();
    assert!(out.stdout.contains("slopmax stopped"), "{out:?}");
    eventually("the proxy exits", || {
        s.run(&["proxy", "stop"]).stdout.contains("not running")
    });
    let log = std::fs::read_to_string(s.slopmax.join("slopmax.log")).unwrap();
    assert!(!log.is_empty());
    let state = std::fs::read_to_string(s.slopmax.join("state.toml")).unwrap();
    assert!(state.contains(&format!("anthropic = \"{id}\"")), "{state}");
}

#[test]
fn a_broken_config_still_lets_the_proxy_be_stopped_and_diagnosed() {
    let s = Sandbox::new("broken-config");
    s.run(&["proxy", "start"]).ok();
    let path = s.slopmax.join("config.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("strategy = \"fill_first\"\n{text}")).unwrap();

    // Commands that need the whole config say what is wrong and how to fix it.
    let out = s.run(&["status"]);
    assert_eq!(out.code, 1, "{out:?}");
    assert!(
        out.stderr
            .contains("config.toml, line 1: unknown variant `fill_first`"),
        "{out:?}"
    );
    assert!(
        out.stderr
            .contains("fix it, or delete the line to use the default"),
        "{out:?}"
    );
    assert_eq!(out.stderr.trim().lines().count(), 1, "one line: {out:?}");

    // Doctor reports it, and checks the rest: the proxy still runs.
    let out = s.run(&["doctor"]);
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stdout.contains("does not read: line 1"), "{out:?}");
    assert!(
        out.stdout
            .contains(&format!("running on http://127.0.0.1:{}", s.port)),
        "{out:?}"
    );
    s.run(&["completion", "bash"]).ok();
    s.run(&["proxy", "logs", "-n", "1"]).ok();

    // And it stops, with the config's own key.
    let out = s.run(&["proxy", "stop"]).ok();
    assert!(out.stdout.contains("slopmax stopped"), "{out:?}");
    assert!(out.stderr.contains("warning: invalid config"), "{out:?}");

    // Setting the broken setting again fixes it.
    s.run(&["config", "strategy", "fill-first"]).ok();
    s.run(&["status"]).ok();
}

#[test]
fn a_proxy_from_another_home_is_named_not_blamed_on_the_key() {
    let ours = Sandbox::new("home-a");
    let mut other = Sandbox::new("home-b");
    other.port = ours.port;
    ours.run(&["proxy", "start"]).ok();
    let said = "doesn't accept this home's key: it was started from another SLOPMAX_HOME, \
                or before api_key changed. Stop it from there (or end pid ";
    for command in [
        &["status"][..],
        &["proxy", "stop"],
        &["proxy", "start"],
        &["key", "add", "x"],
        &["account", "use", "1"],
    ] {
        let out = other.run(command);
        assert_eq!(out.code, 1, "{command:?}: {out:?}");
        assert!(out.stderr.contains(said), "{command:?}: {out:?}");
        assert!(
            !out.stderr.contains("slopmax agent env"),
            "{command:?}: {out:?}"
        );
    }
    let doctor = other.run(&["doctor"]).stdout;
    assert!(doctor.contains("✗ the slopmax on 127.0.0.1:"), "{doctor}");
    ours.run(&["proxy", "stop"]).ok();
}

#[test]
fn start_says_at_once_why_the_proxy_did_not_start() {
    let s = Sandbox::new("port-held");
    // Holds the port, and never answers what connects.
    let _held = TcpListener::bind(("127.0.0.1", s.port)).unwrap();
    let started = Instant::now();
    let out = s.run(&["proxy", "start"]);
    assert_eq!(out.code, 1, "{out:?}");
    assert!(out.stderr.contains("the proxy did not start: "), "{out:?}");
    // Linux names the program holding it; elsewhere it is "another program".
    assert!(
        out.stderr.contains(&format!("127.0.0.1:{}", s.port))
            && out
                .stderr
                .contains(". Set `listen` in config.toml to a free port."),
        "{out:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn run_without_the_agent_installed_starts_no_proxy() {
    let s = Sandbox::new("run-missing");
    s.run(&["run", "claude"]).fails(
        1,
        "`claude` isn't installed or isn't on PATH. Install Claude Code, then run `slopmax run claude` again.",
    );
    let out = s.run(&["proxy", "stop"]).ok();
    assert!(out.stdout.contains("slopmax is not running"), "{out:?}");
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
    s.run(&["proxy", "stop"]).ok();
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

/// The Windows login service for real: it writes this user's Run key and
/// starts slopmaxw.exe, so it runs only on CI, whose runner is thrown away.
#[cfg(windows)]
#[test]
fn windows_login_service_runs_and_supervises_the_proxy() {
    if std::env::var_os("CI").is_none() {
        eprintln!("skipped: it changes this user's login programs; CI runs it");
        return;
    }
    let s = Sandbox::new("winservice");
    let run = |args: &[&str]| {
        let mut command = s.command(args);
        command.env_remove("SLOPMAX_NO_SERVICE");
        s.finish(command.spawn().unwrap())
    };
    let wait_for = |state: &str| {
        for _ in 0..50 {
            if run(&["proxy", "status"]).stdout.contains(state) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        panic!("service never {state}: {:?}", run(&["proxy", "status"]));
    };

    let out = run(&["proxy", "install"]).ok();
    assert!(
        out.stdout.contains("slopmax now starts at login"),
        "{out:?}"
    );
    assert!(
        out.stdout.contains(r"CurrentVersion\Run\slopmax"),
        "{out:?}"
    );
    wait_for("installed and running");
    let answers = || {
        run(&["doctor"])
            .stdout
            .contains(&format!("running on http://127.0.0.1:{}", s.port))
    };
    assert!(answers(), "the proxy does not answer");

    // A clean stop ends the launcher too, as `systemctl stop` would.
    run(&["proxy", "stop"]).ok();
    wait_for("installed, not running");
    assert!(!answers(), "the proxy outlived `stop`");
    // `start` goes through the service again.
    run(&["proxy", "start"]).ok();
    wait_for("installed and running");
    assert!(answers(), "`start` left the proxy stopped");

    let out = run(&["proxy", "uninstall"]).ok();
    assert!(out.stdout.contains("Removed the service"), "{out:?}");
    wait_for("not installed");
    assert!(!answers(), "the proxy outlived its service");
}

#[test]
fn service_commands_find_no_manager_in_the_sandbox() {
    let s = Sandbox::new("service");
    for action in ["install", "uninstall"] {
        s.run(&["proxy", action])
            .fails(1, "no supported service manager");
    }
    let status = s.run(&["proxy", "status"]).ok().stdout;
    assert!(status.contains("no service manager here"), "{status}");
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
    // The parser refuses what isn't one of the choices, and names them.
    for (args, said) in [
        (&["setup", "--undo"][..], "unexpected argument '--undo'"),
        (
            &["setup", "--strategy", "sideways"][..],
            "reset-first, fill-first",
        ),
        (
            &["setup", "--affinity", "maybe"][..],
            "[possible values: on, off]",
        ),
        (
            &["setup", "--login", "xai"][..],
            "claude, codex, grok, none",
        ),
        (
            &["setup", "--agents", "gemini"][..],
            "claude, codex, grok, none",
        ),
        (
            &["setup", "--import", "dropbox"][..],
            "all, claude-code, codex",
        ),
    ] {
        s.run(args).fails(2, said);
    }
    // `setup <agent>` moved to `agent connect`, and says so.
    s.run(&["setup", "claude", "--undo"])
        .fails(2, "is now `slopmax agent disconnect claude`");
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

    let out = s.run(&["proxy", "stop"]).ok();
    assert!(out.stdout.contains("slopmax stopped"), "{out:?}");
}

#[test]
fn unattended_setup_leaves_alone_an_agent_it_has_no_account_for() {
    let s = Sandbox::new("init-unserved");
    // Claude Code is installed; Grok Build is not.
    let claude = s.stubs.join(if cfg!(windows) {
        "claude.cmd"
    } else {
        "claude"
    });
    write(&claude, "#!/bin/sh\nexit 0\n");
    make_executable(&claude);
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
    // An agent that isn't installed goes unmentioned.
    assert!(!text.contains("Grok Build left"), "{text}");
    assert!(text.contains("1 account behind"), "{text}");
    // Claude Code keeps working as it did; Codex goes through slopmax.
    assert!(!s.claude.join("settings.json").exists());
    let toml = std::fs::read_to_string(s.codex.join("config.toml")).unwrap();
    assert!(toml.contains(&format!("127.0.0.1:{}", s.port)), "{toml}");
    s.run(&["proxy", "stop"]).ok();
}

#[test]
fn setup_follows_cliproxyapi_or_takes_over_with_own() {
    for own in [false, true] {
        let s = Sandbox::new(if own { "init-own" } else { "init-follow" });
        write(
            &s.home.join(".cli-proxy-api/codex-a.json"),
            &json!({"type": "codex", "access_token": "tok-a", "refresh_token": "ref-a",
                    "email": "a@x.dev", "account_id": "ws-a"})
            .to_string(),
        );
        let mut args = vec!["setup", "--yes", "--import", "cliproxyapi"];
        if own {
            args.push("--adopt");
        }
        args.extend(["--agents", "none", "--no-service"]);
        s.run(&args).ok();
        s.run(&["proxy", "stop"]);
        let status = s.run(&["status"]).ok().stdout;
        let hint =
            "1 account follows cliproxyapi, which renews its sign-in: `slopmax account adopt all`";
        assert_eq!(status.contains(hint), !own, "{status}");
    }
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
    s.run(&["proxy", "stop"]).ok();
}

/// A chat endpoint whose answers stream slowly: `/v1/models` lists one
/// model, and each completion sends ten events 200 ms apart. Plain TCP, so
/// the pace is the test's own.
#[cfg(unix)]
async fn slow_endpoint() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                // The headers, then as much body as they announce.
                let (head, length) = loop {
                    let Ok(n) = socket.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (head, end + 4 + length);
                    }
                };
                while request.len() < length {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                if head.starts_with("get /v1/models") {
                    let body = r#"{"data":[{"id":"slow-model"}]}"#;
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                    return;
                }
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n")
                    .await;
                for i in 0..10 {
                    let event = format!(
                        "data: {{\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"slow-model\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"part{i} \"}}}}]}}\n\n"
                    );
                    if socket.write_all(event.as_bytes()).await.is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                let _ = socket.write_all(b"data: [DONE]\n\n").await;
            });
        }
    });
    url
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn handing_the_proxy_to_another_binary_refuses_and_cuts_off_nothing() {
    use slopmax_core::net::Client;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let upstream = slow_endpoint().await;
    let s = Arc::new(Sandbox::new("handoff"));
    let login = {
        let s = s.clone();
        let url = format!("{upstream}/v1");
        tokio::task::spawn_blocking(move || {
            s.run_with(
                &["login", "compat", "--url", &url, "--models", "slow-model"],
                "sk-slow\n",
            )
        })
        .await
        .unwrap()
    };
    assert_eq!(login.code, 0, "{login:?}");
    let key = owner_key(&s);
    let base = format!("http://127.0.0.1:{}", s.port);

    let mut first = s.command(&["serve"]).spawn().unwrap();
    let http = Client::builder().plain_http().build();
    let health = |http: Client, base: String| async move {
        let response = http.get(format!("{base}/healthz")).send().await.ok()?;
        response.json::<Value>().await.ok()
    };
    let start = Instant::now();
    while health(http.clone(), base.clone()).await.is_none() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the proxy never answered"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        health(http.clone(), base.clone()).await.unwrap()["pid"],
        first.id()
    );
    // A connection opened before the move, idle through it.
    let held = Client::builder().plain_http().build();
    assert_eq!(
        health(held.clone(), base.clone()).await.unwrap()["pid"],
        first.id()
    );

    // A stream under way when the proxy moves…
    let streaming = {
        let (http, base, key) = (http.clone(), base.clone(), key.clone());
        tokio::spawn(async move {
            let response = http
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth(&key)
                .json(&json!({
                    "model": "slow-model",
                    "stream": true,
                    "messages": [{ "role": "user", "content": "hi" }]
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            response.text().await.unwrap()
        })
    };
    // …and new connections, one after another, all through the move.
    let stop = Arc::new(AtomicBool::new(false));
    let (answered, refused) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let knocking = {
        let (stop, answered, refused) = (stop.clone(), answered.clone(), refused.clone());
        let base = base.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::SeqCst) {
                let fresh = Client::builder().plain_http().build();
                match health(fresh, base.clone()).await {
                    Some(_) => answered.fetch_add(1, Ordering::SeqCst),
                    None => refused.fetch_add(1, Ordering::SeqCst),
                };
            }
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;

    let exe = env!("CARGO_BIN_EXE_slopmax");
    let moved = http
        .post(format!("{base}/slopmax/api/shutdown"))
        .bearer_auth(&key)
        .json(&json!({ "exe": exe }))
        .send()
        .await
        .unwrap();
    assert_eq!(moved.status(), 200, "{:?}", moved.text().await);
    // A new connection reaches the new process…
    let now = health(Client::builder().plain_http().build(), base.clone())
        .await
        .unwrap();
    let second = now["pid"].as_u64().unwrap() as u32;
    assert_ne!(second, first.id(), "{now}");
    // …and one opened before the move still answers, from the old one,
    // which closes it after: no client finds its connection gone.
    let kept = held.get(format!("{base}/healthz")).send().await.unwrap();
    assert_eq!(
        kept.headers()
            .get("connection")
            .map(|v| v.to_str().unwrap()),
        Some("close")
    );
    let kept: Value = kept.json().await.unwrap();
    assert_eq!(kept["pid"], first.id());
    let after = health(http.clone(), base.clone()).await.unwrap();
    assert_eq!(after["pid"], second);

    let text = tokio::time::timeout(Duration::from_secs(20), streaming)
        .await
        .expect("the stream ends")
        .unwrap();
    for i in 0..10 {
        assert!(
            text.contains(&format!("part{i} ")),
            "part {i} missing: {text}"
        );
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop.store(true, Ordering::SeqCst);
    knocking.await.unwrap();
    assert_eq!(
        refused.load(Ordering::SeqCst),
        0,
        "connections refused during the move"
    );
    assert!(answered.load(Ordering::SeqCst) > 10);

    // The first process stands in for the second with whatever started it:
    // stopping the proxy ends both, cleanly.
    assert!(
        first.try_wait().unwrap().is_none(),
        "the first process left"
    );
    s.run(&["proxy", "stop"]).ok();
    let start = Instant::now();
    loop {
        if let Some(status) = first.try_wait().unwrap() {
            assert!(status.success(), "{status:?}");
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "the first process kept running"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let left = std::fs::read_to_string(s.slopmax.join(".serve.pid")).unwrap();
    assert_eq!(left.trim(), second.to_string());
}

/// Starts `slopmax serve` as systemd starts a unit whose store holds
/// `listener`: as fd 3, named in `LISTEN_FDNAMES`, for its own pid, with
/// `NOTIFY_SOCKET` at `notify`. Its output goes to `<name>.log`.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn serve_on_kept_socket(s: &Sandbox, listener: &TcpListener, notify: &Path, name: &str) -> Child {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let template = s.command(&["serve"]);
    let mut command = Command::new("/bin/sh");
    command.env_clear();
    for (key, value) in template.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
    let log = std::fs::File::create(s.root.join(format!("{name}.log"))).unwrap();
    command
        .args([
            "-c",
            "LISTEN_PID=$$ exec \"$0\" serve",
            env!("CARGO_BIN_EXE_slopmax"),
        ])
        .env("LISTEN_FDS", "1")
        .env("LISTEN_FDNAMES", "listener")
        .env("NOTIFY_SOCKET", notify)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log);
    let fd = listener.as_raw_fd();
    // SAFETY: dup2 and fcntl are async-signal-safe, and touch only the
    // child's own descriptors.
    unsafe {
        command.pre_exec(move || {
            if fd == 3 {
                libc::fcntl(3, libc::F_SETFD, 0);
            } else if libc::dup2(fd, 3) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().unwrap()
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_proxy_started_on_the_kept_socket_takes_over_without_refusing_a_connection() {
    use slopmax_core::net::Client;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let upstream = slow_endpoint().await;
    let s = Arc::new(Sandbox::new("kept-socket"));
    let login = {
        let s = s.clone();
        let url = format!("{upstream}/v1");
        tokio::task::spawn_blocking(move || {
            s.run_with(
                &["login", "compat", "--url", &url, "--models", "slow-model"],
                "sk-slow\n",
            )
        })
        .await
        .unwrap()
    };
    assert_eq!(login.code, 0, "{login:?}");
    let key = owner_key(&s);
    let base = format!("http://127.0.0.1:{}", s.port);

    // The socket the service manager keeps, and where it hears from the
    // proxy.
    let kept = TcpListener::bind(("127.0.0.1", s.port)).unwrap();
    let notify_path = s.root.join("notify.sock");
    let notify = std::os::unix::net::UnixDatagram::bind(&notify_path).unwrap();
    notify
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();

    let mut first = serve_on_kept_socket(&s, &kept, &notify_path, "first");
    let mut heard = Vec::new();
    while !(heard.iter().any(|m| m == "READY=1")
        && heard.iter().any(|m| m == "FDSTORE=1\nFDNAME=listener"))
    {
        let mut buffer = [0u8; 512];
        let n = notify
            .recv(&mut buffer)
            .unwrap_or_else(|e| panic!("systemd isn't told ({e}): {heard:?}"));
        heard.push(String::from_utf8_lossy(&buffer[..n]).into_owned());
    }
    let http = Client::builder().plain_http().build();
    let health = |http: Client, base: String| async move {
        let response = http.get(format!("{base}/healthz")).send().await.ok()?;
        response.json::<Value>().await.ok()
    };
    assert_eq!(
        health(http.clone(), base.clone()).await.unwrap()["pid"],
        first.id()
    );

    // A stream under way when the next process starts…
    let streaming = {
        let (http, base, key) = (http.clone(), base.clone(), key.clone());
        tokio::spawn(async move {
            let response = http
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth(&key)
                .json(&json!({
                    "model": "slow-model",
                    "stream": true,
                    "messages": [{ "role": "user", "content": "hi" }]
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            response.text().await.unwrap()
        })
    };
    // …and new connections, one after another, all through the change.
    let stop = Arc::new(AtomicBool::new(false));
    let (answered, refused) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let knocking = {
        let (stop, answered, refused) = (stop.clone(), answered.clone(), refused.clone());
        let base = base.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::SeqCst) {
                let fresh = Client::builder().plain_http().build();
                match health(fresh, base.clone()).await {
                    Some(_) => answered.fetch_add(1, Ordering::SeqCst),
                    None => refused.fetch_add(1, Ordering::SeqCst),
                };
            }
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The next process finds the home served, and has the first make way.
    let mut second = serve_on_kept_socket(&s, &kept, &notify_path, "second");
    let start = Instant::now();
    loop {
        let now = health(Client::builder().plain_http().build(), base.clone()).await;
        if now.is_some_and(|h| h["pid"] == second.id()) {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "the second process never took over: {}",
            std::fs::read_to_string(s.root.join("second.log")).unwrap_or_default()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let text = tokio::time::timeout(Duration::from_secs(20), streaming)
        .await
        .expect("the stream ends")
        .unwrap();
    for i in 0..10 {
        assert!(
            text.contains(&format!("part{i} ")),
            "part {i} missing: {text}"
        );
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop.store(true, Ordering::SeqCst);
    knocking.await.unwrap();
    assert_eq!(
        refused.load(Ordering::SeqCst),
        0,
        "connections refused while the second process took over"
    );
    assert!(answered.load(Ordering::SeqCst) > 10);

    // Its connections closed, the first process is done, and the second
    // holds the home.
    drop(http);
    let start = Instant::now();
    loop {
        if let Some(status) = first.try_wait().unwrap() {
            assert!(status.success(), "{status:?}");
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "the first process kept running"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let holder = std::fs::read_to_string(s.slopmax.join(".serve.pid")).unwrap();
    assert_eq!(holder.trim(), second.id().to_string());
    assert!(second.try_wait().unwrap().is_none());
    s.run(&["proxy", "stop"]).ok();
    let start = Instant::now();
    while second.try_wait().unwrap().is_none() {
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "the second process kept running"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A fake `tailscale`: it answers from the files in `$FAKE_TS`, logs each
/// run to the stub log, and keeps what `serve` publishes in serve.json.
/// Marker files there make it hang, find tailscaled down, refuse serve
/// changes as Tailscale does without operator rights, or refuse a socket
/// as Tailscale does to anyone but root.
#[cfg(unix)]
const FAKE_TAILSCALE: &str = r#"#!/bin/sh
echo "tailscale $*" >> "$STUB_LOG"
d="$FAKE_TS"
[ -f "$d/hang" ] && exec sleep 60
if [ -f "$d/daemon-down" ]; then
  echo "failed to connect to local tailscaled; it doesn't appear to be running" >&2
  exit 1
fi
case "$*" in
  "status --json"*) cat "$d/status.json" ;;
  "serve status --json")
    if [ -f "$d/serve.json" ]; then cat "$d/serve.json"; else echo '{}'; fi ;;
  "serve --bg --yes --https="*)
    if [ -f "$d/access-denied" ]; then echo "Access denied: serve config denied" >&2; exit 1; fi
    case "$5" in unix:*) if [ -f "$d/root-only" ]; then
      echo "sending serve config: 401 Unauthorized: must be root to serve a path or Unix socket" >&2
      exit 1
    fi ;; esac
    port="${4#--https=}"
    printf '{"TCP":{"%s":{"HTTPS":true}},"Web":{"hub.example.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}\n' "$port" "$port" "$5" > "$d/serve.json" ;;
  "serve --https="*" off")
    if [ -f "$d/access-denied" ]; then echo "Access denied: serve config denied" >&2; exit 1; fi
    echo '{}' > "$d/serve.json" ;;
  "debug prefs") cat "$d/prefs.json" ;;
  *) exit 1 ;;
esac
"#;

/// A `tailscale status --json` recorded from Tailscale 1.104.5, scrubbed.
#[cfg(unix)]
fn status_fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../slopmax-core/tests-data/tailscale")
        .join(format!("status-{name}.json"));
    std::fs::read_to_string(path).unwrap()
}

#[cfg(unix)]
impl Sandbox {
    /// Puts the fake `tailscale` in the stub's place, signed in and
    /// running, with this user as tailscaled's operator.
    fn fake_tailscale(&self) {
        let path = self.stubs.join("tailscale");
        std::fs::write(&path, FAKE_TAILSCALE).unwrap();
        make_executable(&path);
        std::fs::create_dir_all(self.ts_dir()).unwrap();
        self.ts_file("status.json", &status_fixture("running"));
        self.ts_file("prefs.json", r#"{"OperatorUser": "tester"}"#);
    }

    fn ts_dir(&self) -> PathBuf {
        self.root.join("ts")
    }

    fn ts_file(&self, name: &str, text: &str) {
        std::fs::write(self.ts_dir().join(name), text).unwrap();
    }

    fn ts_marker(&self, name: &str, on: bool) {
        let path = self.ts_dir().join(name);
        if on {
            std::fs::write(path, "").unwrap();
        } else {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Runs as the user `tester`, tailscaled's operator in the fake.
    fn ts(&self, args: &[&str]) -> Out {
        self.finish(self.command(args).env("USER", "tester").spawn().unwrap())
    }

    /// The `tailscale serve` runs that change what is published.
    fn serve_changes(&self) -> Vec<String> {
        self.stub_calls()
            .lines()
            .filter(|l| l.starts_with("tailscale serve --"))
            .map(str::to_owned)
            .collect()
    }

    fn clear_stub_log(&self) {
        let _ = std::fs::remove_file(self.root.join("stubs.log"));
    }

    /// Answers `/healthz` on the proxy's tailnet socket, as the proxy does,
    /// for as long as the test runs. A proxy that binds the socket itself
    /// replaces it.
    fn answer_on_socket(&self) {
        use std::io::Read as _;
        std::fs::create_dir_all(&self.slopmax).unwrap();
        let listener =
            std::os::unix::net::UnixListener::bind(self.slopmax.join("tailnet.sock")).unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
                );
            }
        });
    }

    /// What `tailscale serve` would say publishes `proxy` on the
    /// sandbox's port.
    fn serving(&self, proxy: &str) -> String {
        json!({
            "TCP": { self.port.to_string(): { "HTTPS": true } },
            "Web": { format!("hub.example.ts.net:{}", self.port): {
                "Handlers": { "/": { "Proxy": proxy } }
            } }
        })
        .to_string()
    }

    fn socket_target(&self) -> String {
        format!("unix:{}", self.slopmax.join("tailnet.sock").display())
    }

    /// The private path on the proxy's port, from the sandbox's owner key.
    fn private_target(&self) -> String {
        let path = slopmax_core::tailscale::private_path(&owner_key(self));
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

#[cfg(unix)]
#[test]
fn tailscale_on_publishes_the_socket_and_off_takes_it_down() {
    let s = Sandbox::short("ts-on");
    s.fake_tailscale();
    s.answer_on_socket();
    let port = s.port;

    // Without operator rights, serve says so, and slopmax says what to run.
    s.ts_marker("access-denied", true);
    s.ts(&["tailscale", "on"])
        .fails(1, "sudo tailscale set --operator=$USER");
    s.ts_marker("access-denied", false);

    // Only root may publish a socket, even the operator: slopmax says the
    // one command that does it, and finishes once it has been run.
    s.ts_marker("root-only", true);
    let by_hand = format!(
        "then run `slopmax tailscale on --socket` again:\n  sudo tailscale serve --bg --yes \
         --https={port} {}",
        s.socket_target()
    );
    let out = s
        .ts(&["tailscale", "on", "--socket"])
        .fails(1, "Tailscale lets only root publish a socket.");
    assert!(out.stderr.contains(&by_hand), "{out:?}");
    assert!(out.stderr.contains("Or leave out --socket"), "{out:?}");
    assert!(!out.stderr.contains("--operator"), "{out:?}");
    s.ts_file("serve.json", &s.serving(&s.socket_target()));
    s.clear_stub_log();
    let out = s.ts(&["tailscale", "on", "--socket"]).ok();
    assert!(s.serve_changes().is_empty(), "{}", s.stub_calls());
    assert!(
        out.stdout
            .contains(&format!("https://hub.example.ts.net:{port}")),
        "{out:?}"
    );
    // Plain `on` moves it to the private path, which needs no root.
    s.clear_stub_log();
    s.ts(&["tailscale", "on"]).ok();
    assert_eq!(
        s.serve_changes(),
        [format!(
            "tailscale serve --bg --yes --https={port} {}",
            s.private_target()
        )]
    );
    s.ts_marker("root-only", false);
    // A private path from an older owner key is slopmax's own: replaced.
    let older = format!(
        "http://127.0.0.1:{port}{}",
        slopmax_core::tailscale::private_path("sm-older")
    );
    s.ts_file("serve.json", &s.serving(&older));
    let table = s.ts(&["tailscale"]).ok().stdout;
    assert!(
        table.contains("an older owner key's private path"),
        "{table}"
    );
    assert!(!table.contains(&older), "{table}");
    s.clear_stub_log();
    s.ts(&["tailscale", "on"]).ok();
    assert_eq!(s.serve_changes().len(), 1, "{}", s.stub_calls());
    let _ = std::fs::remove_file(s.ts_dir().join("serve.json"));
    s.clear_stub_log();

    // `--user` adds a login to the hub's own.
    let out = s.ts(&["tailscale", "on", "--user", "you@github"]).ok();
    assert_eq!(
        s.serve_changes(),
        [format!(
            "tailscale serve --bg --yes --https={port} {}",
            s.private_target()
        )]
    );
    let table = s.ts(&["tailscale"]).ok().stdout;
    assert!(
        table.contains(&format!("-> a private path on http://127.0.0.1:{port}")),
        "{table}"
    );
    assert!(!table.contains(".slopmax-tailnet-"), "{table}");
    let url = format!("https://hub.example.ts.net:{port}");
    assert!(out.stdout.contains(&url), "{out:?}");
    assert!(
        out.stdout
            .contains("Machines signed in as me@github or you@github use it without a key"),
        "{out:?}"
    );
    // Not on the port `setup --hub <name>` looks on: the whole address.
    assert!(
        out.stdout
            .contains(&format!("On another machine: slopmax setup --hub {url}\n")),
        "{out:?}"
    );
    // The fake address doesn't resolve from here: a note, not a failure.
    assert!(
        out.stdout
            .contains("couldn't check the address from this machine"),
        "{out:?}"
    );
    let config = std::fs::read_to_string(s.config()).unwrap();
    let doc: toml_edit::DocumentMut = config.parse().unwrap();
    let users: Vec<&str> = doc["tailscale"]["users"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert_eq!(users, ["me@github", "you@github"], "{config}");

    // The dashboard says where the other machines find it.
    let out = s.ts(&["dashboard", "--no-browser"]).ok();
    assert!(
        out.stdout.contains(&format!(
            "From your other machines and phone: {url}/slopmax/ (no key needed)"
        )),
        "{out:?}"
    );
    let out = s
        .command(&["dashboard", "--no-browser"])
        .env("SLOPMAX_TAILSCALE", "")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("ssh -L"));
    // A key for another machine comes with how that machine uses it.
    let out = s.ts(&["key", "add", "ci"]).ok();
    assert!(
        out.stderr.contains(&format!(
            "On that machine: slopmax setup --hub {url} --hub-key sm-"
        )),
        "{out:?}"
    );

    let view: slopmax_client::api::tailnet::TailnetView =
        serde_json::from_str(&s.ts(&["tailscale", "status", "--json"]).ok().stdout).unwrap();
    assert_eq!(view.url.as_deref(), Some(url.as_str()));
    assert_eq!(view.users, ["me@github", "you@github"]);
    assert_eq!(
        view.tailscale,
        slopmax_client::api::tailnet::TailscaleState::Running
    );
    let table = s.ts(&["tailscale"]).ok().stdout;
    assert!(
        table.contains("running, me@github on hub (1.104.5)"),
        "{table}"
    );
    assert!(table.contains(&format!("{url} -> ")), "{table}");
    assert!(
        table.contains("me@github, you@github (use and view)"),
        "{table}"
    );

    // On the usual port, other machines find it by name.
    let out = s.ts(&["tailscale", "on", "--port", "7567"]).ok();
    assert!(
        out.stdout
            .contains("On another machine: slopmax setup --hub hub\n"),
        "{out:?}"
    );

    // On again changes nothing but what serve publishes.
    s.ts(&["tailscale", "on"]).ok();

    s.clear_stub_log();
    let out = s.ts(&["tailscale", "off"]).ok();
    assert!(
        out.stdout
            .contains("Stopped publishing slopmax to your tailnet."),
        "{out:?}"
    );
    assert_eq!(
        s.serve_changes(),
        [format!("tailscale serve --https={port} off")]
    );
    let out = s.ts(&["tailscale", "off"]).ok();
    assert!(
        out.stdout
            .contains("slopmax isn't published to your tailnet."),
        "{out:?}"
    );
    let out = s.ts(&["dashboard", "--no-browser"]).ok();
    assert!(
        out.stdout
            .contains("To open it from your other machines, run slopmax tailscale on"),
        "{out:?}"
    );

    // The proxy's port instead: every machine needs a key then.
    s.clear_stub_log();
    let out = s.ts(&["tailscale", "on", "--loopback"]).ok();
    assert_eq!(
        s.serve_changes(),
        [format!(
            "tailscale serve --bg --yes --https={port} http://127.0.0.1:{port}"
        )]
    );
    assert!(out.stdout.contains("every machine needs a key"), "{out:?}");
    s.ts(&["tailscale", "off"]).ok();
    s.run(&["proxy", "stop"]).ok();
    s.assert_no_mutating_tailscale();
}

#[cfg(unix)]
#[test]
fn tailscale_on_says_what_stops_it() {
    let s = Sandbox::short("ts-refused");
    s.fake_tailscale();
    let port = s.port;
    let refused = |says: &str| {
        s.ts(&["tailscale", "on"]).fails(1, says);
        assert!(s.serve_changes().is_empty(), "{}", s.stub_calls());
    };
    s.ts_file("status.json", &status_fixture("needslogin"));
    refused("Tailscale on this machine is signed out");
    s.ts_file("status.json", &status_fixture("stopped"));
    refused("Tailscale on this machine is turned off\ntailscale up");
    s.ts_file("status.json", &status_fixture("nocerts"));
    refused("your tailnet has HTTPS certificates turned off\nTurn on HTTPS");
    s.ts_file("status.json", &status_fixture("running"));

    s.ts_file("serve.json", &s.serving("http://127.0.0.1:3000"));
    refused(&format!(
        "port {port} of this machine already serves http://127.0.0.1:3000 to your tailnet\n\
         slopmax tailscale on --port {}",
        port + 1
    ));
    // slopmax published from another home: `on` leaves it, and says how to
    // turn it off, as status does.
    let old = "unix:/home/old/.slopmax/tailnet.sock";
    s.ts_file("serve.json", &s.serving(old));
    refused(&format!(
        "If that is slopmax from before, turn it off first: tailscale serve --https={port} off"
    ));
    let table = s.ts(&["tailscale"]).ok().stdout;
    assert!(
        table.contains(&format!(
            "port {port} serves {old}, likely slopmax from before: `tailscale serve \
             --https={port} off`, then `slopmax tailscale on`"
        )),
        "{table}"
    );
    s.ts_file(
        "serve.json",
        &json!({ "TCP": { port.to_string(): { "TCPForward": "127.0.0.1:22" } } }).to_string(),
    );
    refused("already serves 127.0.0.1:22");
    let mut funnel: Value = serde_json::from_str(&s.serving(&s.socket_target())).unwrap();
    funnel["AllowFunnel"] = json!({ format!("hub.example.ts.net:{port}"): true });
    s.ts_file("serve.json", &funnel.to_string());
    refused(&format!(
        "port {port} is open to the internet through Tailscale Funnel\n\
         tailscale funnel --https={port} off"
    ));
    let _ = std::fs::remove_file(s.ts_dir().join("serve.json"));

    s.ts_marker("daemon-down", true);
    refused("Tailscale isn't running on this machine");
    s.ts_marker("daemon-down", false);

    let out = s
        .command(&["tailscale", "on"])
        .env("SLOPMAX_TAILSCALE", "")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("Tailscale isn't installed here"),
        "{out:?}"
    );
    s.run(&["tailscale", "on", "--loopback", "--socket"])
        .fails(2, "'--loopback' cannot be used with '--socket'");
    // Nothing started a proxy for it.
    assert!(
        s.run(&["proxy", "stop"])
            .ok()
            .stdout
            .contains("not running")
    );
    s.assert_no_mutating_tailscale();
}

/// Without operator rights, `on` stops before it publishes anything, and
/// says what to run once.
#[cfg(target_os = "linux")]
#[test]
fn tailscale_on_without_operator_rights_says_how_to_get_them() {
    let s = Sandbox::short("ts-operator");
    if slopmax_core::tailscale::is_root() {
        eprintln!("skipped: root needs no operator rights");
        return;
    }
    s.fake_tailscale();
    s.ts_file("prefs.json", "{}");
    // The private path needs only the operator.
    let out = s.ts(&["tailscale", "on"]).fails(
        1,
        "Tailscale lets only root change what this machine serves.",
    );
    assert!(
        out.stderr.contains("  sudo tailscale set --operator=$USER"),
        "{out:?}"
    );
    assert!(out.stderr.contains(&s.private_target()), "{out:?}");
    // The socket needs root, which the operator wouldn't have either.
    let out = s
        .ts(&["tailscale", "on", "--socket"])
        .fails(1, "Tailscale lets only root publish a socket.");
    assert!(
        out.stderr.contains(&format!(
            "  sudo tailscale serve --bg --yes --https={} {}",
            s.port,
            s.socket_target()
        )),
        "{out:?}"
    );
    assert!(!out.stderr.contains("--operator"), "{out:?}");
    // The proxy's port needs only the operator.
    let out = s.ts(&["tailscale", "on", "--loopback"]).fails(
        1,
        "Tailscale lets only root change what this machine serves.",
    );
    assert!(
        out.stderr.contains("  sudo tailscale set --operator=$USER"),
        "{out:?}"
    );
    assert!(s.serve_changes().is_empty(), "{}", s.stub_calls());
    assert!(
        s.run(&["proxy", "stop"])
            .ok()
            .stdout
            .contains("not running")
    );
    s.assert_no_mutating_tailscale();
}

#[cfg(unix)]
#[test]
fn tailscale_users_and_admins_edit_the_config() {
    let s = Sandbox::short("ts-users");
    s.fake_tailscale();
    let out = s.ts(&["tailscale", "user"]).ok();
    assert!(out.stdout.contains("No login is let in"), "{out:?}");
    s.ts(&["tailscale", "user", "add", "me@github,you@github"])
        .ok();
    s.ts(&["tailscale", "user", "add", "nobody"])
        .fails(1, "is not a tailnet login");
    s.ts(&["tailscale", "admin", "add", "ci-runner"])
        .fails(1, "ci-runner is tagged (tag:ci)");
    s.ts(&["tailscale", "admin", "add", "phone"])
        .fails(1, "no machine on your tailnet is called phone");
    let out = s.ts(&["tailscale", "admin", "add", "me-macbook-pro"]).ok();
    assert!(
        out.stdout.contains("me-macbook-pro may now manage"),
        "{out:?}"
    );
    s.ts(&["tailscale", "user", "remove", "you@github"]).ok();
    s.ts(&["tailscale", "user", "remove", "you@github"])
        .fails(1, "isn't among the logins");

    let doc: toml_edit::DocumentMut = std::fs::read_to_string(s.config())
        .unwrap()
        .parse()
        .unwrap();
    let table = &doc["tailscale"];
    assert_eq!(
        table["users"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>(),
        ["me@github"]
    );
    let admin = table["admins"].as_array().unwrap().get(0).unwrap();
    let admin = admin.as_inline_table().unwrap();
    assert_eq!(
        admin.get("machine").and_then(|v| v.as_str()),
        Some("me-macbook-pro")
    );
    assert_eq!(admin.get("id").and_then(|v| v.as_str()), Some("nMAC1CNTRL"));
    let list = s.ts(&["tailscale", "admin"]).ok().stdout;
    assert!(
        list.contains("me-macbook-pro") && list.contains("nMAC1CNTRL"),
        "{list}"
    );
    s.ts(&["tailscale", "admin", "remove", "me-macbook-pro"])
        .ok();
    assert!(
        !std::fs::read_to_string(s.config())
            .unwrap()
            .contains("nMAC1CNTRL")
    );
    s.assert_no_mutating_tailscale();
}

#[cfg(unix)]
#[test]
fn a_tailscale_that_hangs_times_out() {
    let s = Sandbox::short("ts-hang");
    s.fake_tailscale();
    s.ts_marker("hang", true);
    let started = Instant::now();
    s.ts(&["tailscale", "on"]).fails(1, "didn't answer in time");
    let took = started.elapsed();
    assert!(took < Duration::from_secs(8), "{took:?}");
    let out = s.ts(&["tailscale", "status"]).ok();
    assert!(out.stdout.contains("didn't answer in time"), "{out:?}");
    s.assert_no_mutating_tailscale();
}

#[cfg(unix)]
#[test]
fn looking_for_a_hub_with_no_other_machines_says_how_to_name_one() {
    let s = Sandbox::short("ts-discover");
    s.fake_tailscale();
    let mut status: Value = serde_json::from_str(&status_fixture("running")).unwrap();
    status.as_object_mut().unwrap().remove("Peer");
    s.ts_file("status.json", &status.to_string());
    let says = "no slopmax answered on your tailnet at port 7567; pass one: slopmax setup --hub";
    s.ts(&["setup", "--find-hub"]).fails(1, says);
    s.ts(&["setup", "--hub="]).fails(1, says);
    s.ts(&["setup", "--hub", "phone"])
        .fails(1, "no machine on your tailnet is called phone");
    // A name with a port is still looked up, not dialed as it stands.
    s.ts(&["setup", "--hub", "phone:7600"])
        .fails(1, "no machine on your tailnet is called phone");
    assert!(!has_hub(&s));
    s.assert_no_mutating_tailscale();
}

/// Whether a sandbox's config.toml sets `[hub]` (its template only shows
/// one, commented out).
fn has_hub(s: &Sandbox) -> bool {
    let text = std::fs::read_to_string(s.config()).unwrap_or_default();
    let doc: toml_edit::DocumentMut = text.parse().unwrap();
    doc.get("hub").is_some()
}

/// The owner's key from a sandbox's config.toml.
fn owner_key(s: &Sandbox) -> String {
    let doc: toml_edit::DocumentMut = std::fs::read_to_string(s.config())
        .unwrap()
        .parse()
        .unwrap();
    doc["api_key"].as_str().unwrap().to_owned()
}

#[test]
fn a_machine_uses_another_as_its_hub() {
    let hub = Sandbox::new("hub");
    hub.add(&key(ProviderId::Anthropic, "sk-ant-hub"));
    hub.run(&["proxy", "start"]).ok();
    let owner = owner_key(&hub);
    let at = format!("http://127.0.0.1:{}", hub.port);

    let client = Sandbox::new("client");
    client.add(&claude("mine@x.dev"));
    let accounts_before = client.store().list().unwrap().len();
    let out = client
        .run(&[
            "setup",
            "--hub",
            &at,
            "--hub-key",
            &owner,
            "--key-name",
            "laptop",
            "--yes",
        ])
        .ok();
    assert!(
        out.stdout.contains(&format!(
            "Found slopmax {} at {at}",
            env!("CARGO_PKG_VERSION")
        )),
        "{out:?}"
    );
    assert!(out.stdout.contains("Made the key \"laptop\""), "{out:?}");
    assert!(
        out.stdout.contains("Claude Code now uses the hub"),
        "{out:?}"
    );

    // Only the key made for it is kept, never the owner's.
    let doc: toml_edit::DocumentMut = std::fs::read_to_string(client.config())
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(doc["hub"]["url"].as_str(), Some(at.as_str()));
    let kept = doc["hub"]["key"].as_str().unwrap().to_owned();
    assert!(kept.starts_with("sm-") && kept != owner, "{kept}");
    let keys = hub.run(&["key", "list"]).ok().stdout;
    assert!(keys.contains("laptop"), "{keys}");
    let hub_config = std::fs::read_to_string(hub.config()).unwrap();
    assert!(hub_config.contains(&kept), "{hub_config}");

    // Its agents use the hub, with that key.
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(client.claude.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings["env"]["ANTHROPIC_BASE_URL"],
        at.as_str(),
        "{settings:#}"
    );
    assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], kept.as_str());
    let codex = std::fs::read_to_string(client.codex.join("config.toml")).unwrap();
    assert!(codex.contains(&format!("{at}/codex")), "{codex}");
    let env = client.run(&["agent", "env", "claude"]).ok().stdout;
    assert!(env.contains(&at), "{env}");

    assert!(
        out.stdout.contains("It knows this machine as laptop: use."),
        "{out:?}"
    );
    // A client key may use the hub, not see its accounts: the hub says so.
    client.run(&["status"]).fails(
        1,
        &format!(
            "the hub at {at} takes this machine's key for its agents only, not for \
             `slopmax status`; run it on the hub"
        ),
    );

    // Nothing runs a proxy here.
    let refusal = format!("This machine uses the hub at {at} and runs no proxy of its own.");
    client.run(&["proxy", "start"]).fails(1, &refusal);
    client.run(&["serve"]).fails(1, &refusal);
    client.run(&["account", "import"]).fails(1, &refusal);
    client
        .run(&["proxy", "logs"])
        .fails(1, "The hub's log is on 127.0.0.1");
    client.run(&["tailscale", "on"]).fails(1, &refusal);
    let out = client.run(&["tailscale"]).ok();
    assert!(
        out.stdout
            .contains(&format!("This machine uses the hub at {at}.")),
        "{out:?}"
    );
    let json: Value =
        serde_json::from_str(&client.run(&["tailscale", "status", "--json"]).ok().stdout).unwrap();
    assert_eq!(json, json!({ "hub": at }));
    let doctor = client.run(&["doctor"]).stdout;
    assert!(
        doctor.contains(&format!("the hub at {at} answers")),
        "{doctor}"
    );

    // With the hub gone, commands fail, and never fall back to the
    // accounts here.
    hub.run(&["proxy", "stop"]).ok();
    eventually("the hub stops", || {
        hub.run(&["proxy", "stop"]).stdout.contains("not running")
    });
    client
        .run(&["status"])
        .fails(1, &format!("the hub at {at} isn't answering"));
    client
        .run(&["account", "use", "1"])
        .fails(1, "isn't answering");
    assert_eq!(client.store().list().unwrap().len(), accounts_before);

    // And back to its own proxy.
    let out = client.run(&["setup", "--hub", "off"]).ok();
    assert!(
        out.stdout
            .contains("Its agents now use this machine's proxy."),
        "{out:?}"
    );
    assert!(!has_hub(&client));
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(client.claude.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings["env"]["ANTHROPIC_BASE_URL"],
        format!("http://127.0.0.1:{}", client.port).as_str()
    );
    assert_eq!(client.store().list().unwrap().len(), accounts_before);
    let json: Value = serde_json::from_str(&client.run(&["status", "--json"]).ok().stdout).unwrap();
    assert_eq!(json["accounts"].as_array().unwrap().len(), accounts_before);
    hub.assert_no_mutating_tailscale();
    client.assert_no_mutating_tailscale();
}
