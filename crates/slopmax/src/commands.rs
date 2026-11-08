//! The commands: their table, and running the one asked for.

mod accounts;
mod background;
mod doctor;
mod init;
mod status;
mod usage;

use std::io::IsTerminal;

use anyhow::{Context, Result, bail};

use self::accounts::{
    import, login, own, redeem, remove, rename, set_disabled, set_priority, use_account,
};
use self::background::{ensure_running, service, start, stop};
use crate::args::{self, App, Arg, Choice, Command, Kind, Parsed};
use crate::ui;
use slopmax_core::account::{Endpoint, Store};
use slopmax_core::agent::{self, Agent};
use slopmax_core::auth::{self, LoginOptions};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::net::Origins;
use slopmax_core::provider::ProviderId;
use slopmax_core::time::Timestamp;
use slopmax_core::wire::Dialect;
use slopmax_core::{notify, paths};
use slopmax_daemon as daemon;

const ACCOUNT: &str = "Number from `slopmax status`, or the account's id, email, or label";

const PROVIDERS: &[Choice] = &[
    Choice {
        value: "claude",
        help: "Claude Pro/Max, used by Claude Code",
    },
    Choice {
        value: "codex",
        help: "ChatGPT Plus/Pro/Team, used by Codex",
    },
    Choice {
        value: "anthropic",
        help: "An Anthropic API key (for Claude Code)",
    },
    Choice {
        value: "openai",
        help: "An OpenAI API key",
    },
    Choice {
        value: "xai",
        help: "An xAI API key, for Grok models",
    },
    Choice {
        value: "compat",
        help: "Any OpenAI- or Anthropic-compatible endpoint (needs --url)",
    },
];

const AGENTS: &[Choice] = &[
    Choice {
        value: "claude",
        help: "Claude Code",
    },
    Choice {
        value: "codex",
        help: "Codex",
    },
];

const SOURCES: &[Choice] = &[
    Choice {
        value: "all",
        help: "Every source below",
    },
    Choice {
        value: "claude-code",
        help: "Claude Code's login (~/.claude/.credentials.json or the macOS keychain)",
    },
    Choice {
        value: "codex",
        help: "The Codex CLI login (~/.codex/auth.json)",
    },
    Choice {
        value: "cliproxyapi",
        help: "CLIProxyAPI credential files (~/.cli-proxy-api/*.json)",
    },
];

const SERVICE_ACTIONS: &[Choice] = &[
    Choice {
        value: "install",
        help: "Start slopmax at login (systemd user unit or launchd agent)",
    },
    Choice {
        value: "uninstall",
        help: "Remove the service",
    },
    Choice {
        value: "status",
        help: "Show whether the service is installed and running",
    },
];

const KEY_ACTIONS: &[Choice] = &[
    Choice {
        value: "list",
        help: "Show the keys",
    },
    Choice {
        value: "add",
        help: "Make a key for another machine or tool",
    },
    Choice {
        value: "remove",
        help: "Revoke a key",
    },
];

const RANGES: &[Choice] = &[
    Choice {
        value: "today",
        help: "Since midnight",
    },
    Choice {
        value: "7d",
        help: "Today and the 6 days before",
    },
    Choice {
        value: "30d",
        help: "Today and the 29 days before",
    },
    Choice {
        value: "all",
        help: "Everything recorded",
    },
];

const SHELLS: &[Choice] = &[
    Choice {
        value: "bash",
        help: "Bash",
    },
    Choice {
        value: "zsh",
        help: "Zsh",
    },
    Choice {
        value: "fish",
        help: "Fish",
    },
];

const fn arg(name: &'static str, help: &'static str, kind: Kind) -> Arg {
    Arg { name, help, kind }
}

const fn command(name: &'static str, about: &'static str, args: &'static [Arg]) -> Command {
    Command {
        name,
        alias: None,
        about,
        args,
    }
}

const ACCOUNT_ARG: Arg = arg("account", ACCOUNT, Kind::Required(&[]));

pub static APP: App = App {
    name: "slopmax",
    about: "Multi-account switcher and proxy for Claude Code and Codex",
    after_help: "Run without a command to show account status.",
    default: "status",
    commands: &[
        Command {
            name: "setup",
            alias: Some("init"),
            about: "Set everything up step by step, or point one agent at the proxy",
            args: &[
                arg(
                    "agent",
                    "Wire just this agent (else run the whole setup)",
                    Kind::Optional(AGENTS, ""),
                ),
                arg(
                    "undo",
                    "With an agent: restore what setup replaced",
                    Kind::Flag(None),
                ),
                arg(
                    "yes",
                    "Ask nothing: take the flags, else the recommended answers",
                    Kind::Flag(Some('y')),
                ),
                arg(
                    "import",
                    "Take logins from claude-code, codex, cliproxyapi, all, or none",
                    Kind::Value(None, "SOURCES"),
                ),
                arg(
                    "login",
                    "Sign in to these subscriptions: claude, codex",
                    Kind::Value(None, "PROVIDERS"),
                ),
                arg(
                    "keys-from-env",
                    "Add the keys in ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY",
                    Kind::Flag(None),
                ),
                arg(
                    "strategy",
                    "reset-first, fill-first, least-used, or round-robin",
                    Kind::Value(None, "STRATEGY"),
                ),
                arg(
                    "affinity",
                    "on: sessions keep their account; off: every request placed afresh",
                    Kind::Value(None, "on|off"),
                ),
                arg(
                    "agents",
                    "Point these agents at the proxy: claude, codex, or none",
                    Kind::Value(None, "AGENTS"),
                ),
                arg(
                    "no-service",
                    "Don't start slopmax at login",
                    Kind::Flag(None),
                ),
            ],
        },
        Command {
            name: "status",
            alias: Some("ls"),
            about: "Show accounts, usage windows, and when limits reset",
            args: &[
                arg(
                    "refresh",
                    "Fetch fresh usage from the providers first",
                    Kind::Flag(Some('r')),
                ),
                arg("watch", "Keep the display updated", Kind::Flag(Some('w'))),
                arg("json", "Print machine-readable JSON", Kind::Flag(None)),
            ],
        },
        command(
            "login",
            "Connect an account: sign in, or enter an API key",
            &[
                arg(
                    "provider",
                    "Which kind of account",
                    Kind::Required(PROVIDERS),
                ),
                arg(
                    "label",
                    "Display name for the account",
                    Kind::Value(None, "LABEL"),
                ),
                arg(
                    "device",
                    "Sign in with a code instead of a browser redirect (Codex only)",
                    Kind::Flag(None),
                ),
                arg(
                    "no-browser",
                    "Print the sign-in URL instead of opening a browser",
                    Kind::Flag(None),
                ),
                arg(
                    "url",
                    "Compatible endpoint's base URL, e.g. http://localhost:11434/v1",
                    Kind::Value(None, "URL"),
                ),
                arg(
                    "dialect",
                    "Its format: chat (the default), responses, or messages",
                    Kind::Value(None, "DIALECT"),
                ),
                arg(
                    "models",
                    "Models the endpoint serves, comma-separated (default: what it lists)",
                    Kind::Value(None, "MODELS"),
                ),
            ],
        ),
        command(
            "import",
            "Copy existing logins from Claude Code, Codex, or CLIProxyAPI",
            &[
                arg(
                    "source",
                    "Where to import from",
                    Kind::Optional(SOURCES, "all"),
                ),
                arg(
                    "own",
                    "Refresh imported CLIProxyAPI logins here instead of following its files",
                    Kind::Flag(None),
                ),
            ],
        ),
        command(
            "own",
            "Take over refreshing an account slopmax follows from another tool",
            &[arg(
                "account",
                "Number from `slopmax status`, the account's id, email, or label, or `all`",
                Kind::Required(&[]),
            )],
        ),
        command(
            "use",
            "Prefer an account for new sessions, or `auto` to let slopmax choose",
            &[ACCOUNT_ARG],
        ),
        command(
            "label",
            "Set an account's display name",
            &[
                ACCOUNT_ARG,
                arg("label", "The new name", Kind::Required(&[])),
            ],
        ),
        command(
            "priority",
            "Set an account's priority; higher tiers are used first",
            &[
                ACCOUNT_ARG,
                arg(
                    "priority",
                    "Tier, 0 by default; negative values hold an account in reserve",
                    Kind::Required(&[]),
                ),
            ],
        ),
        command("enable", "Route to an account again", &[ACCOUNT_ARG]),
        command(
            "disable",
            "Stop routing to an account (its tokens are still kept fresh)",
            &[ACCOUNT_ARG],
        ),
        command("remove", "Forget an account", &[ACCOUNT_ARG]),
        command(
            "redeem",
            "Redeem a banked limit reset, resetting a Claude or ChatGPT account's limits",
            &[
                ACCOUNT_ARG,
                arg("yes", "Skip the confirmation prompt", Kind::Flag(Some('y'))),
            ],
        ),
        command("serve", "Run the proxy in the foreground", &[]),
        command("start", "Start the proxy in the background", &[]),
        command("stop", "Stop the background proxy", &[]),
        command(
            "service",
            "Run the proxy as a service that starts at login",
            &[arg("action", "What to do", Kind::Required(SERVICE_ACTIONS))],
        ),
        command(
            "run",
            "Launch an agent through the proxy, starting the proxy if needed",
            &[
                arg("agent", "Which agent", Kind::Required(AGENTS)),
                arg("args", "Arguments passed to the agent", Kind::Rest),
            ],
        ),
        command(
            "env",
            "Print shell setup that points an agent at the proxy, for `eval`",
            &[arg("agent", "Which agent", Kind::Required(AGENTS))],
        ),
        command(
            "config",
            "Show the routing and redeem settings, or change one while the proxy runs",
            &[
                arg(
                    "name",
                    "The setting, e.g. strategy",
                    Kind::Optional(&[], ""),
                ),
                arg(
                    "value",
                    "Its new value, e.g. round-robin",
                    Kind::Optional(&[], ""),
                ),
            ],
        ),
        command(
            "usage",
            "Show token usage and its API-equivalent cost",
            &[
                arg("range", "Which period", Kind::Optional(RANGES, "7d")),
                arg(
                    "by",
                    "Group by day, model, or account",
                    Kind::Value(Some('b'), "BY"),
                ),
                arg("json", "Print machine-readable JSON", Kind::Flag(None)),
            ],
        ),
        command(
            "key",
            "Manage keys for other machines and tools",
            &[
                arg("action", "What to do", Kind::Optional(KEY_ACTIONS, "list")),
                arg("name", "The key's name", Kind::Optional(&[], "")),
                arg(
                    "models",
                    "Models it may use, comma-separated patterns (default: any)",
                    Kind::Value(None, "MODELS"),
                ),
            ],
        ),
        command(
            "logs",
            "Show the background proxy's log",
            &[
                arg("follow", "Keep printing new lines", Kind::Flag(Some('f'))),
                arg(
                    "lines",
                    "How many lines to show first (default 40)",
                    Kind::Value(Some('n'), "N"),
                ),
            ],
        ),
        command("notify", "Send a test notification", &[]),
        command(
            "dashboard",
            "Open the dashboard in a browser, starting the proxy if needed",
            &[arg(
                "print",
                "Print its address instead of opening a browser",
                Kind::Flag(None),
            )],
        ),
        command("doctor", "Check the setup and say how to fix problems", &[]),
        command(
            "daemon-info",
            "Where the proxy listens and its key, for the apps that drive it",
            &[arg("json", "As JSON (the only form)", Kind::Flag(None))],
        ),
        command(
            "completions",
            "Print a shell completion script",
            &[arg("shell", "Which shell", Kind::Required(SHELLS))],
        ),
    ],
};

#[derive(Debug, Default)]
pub(super) struct StatusArgs {
    refresh: bool,
    watch: bool,
    json: bool,
}

/// Parses `args` (without the program name), runs the command, and returns
/// the process exit code.
pub async fn run(args: impl IntoIterator<Item = String>) -> Result<i32> {
    let args: Vec<String> = args.into_iter().collect();
    let bare = args.is_empty();
    let matches = match args::parse(&APP, args) {
        Ok(Parsed::Run(matches)) => matches,
        Ok(Parsed::Print(text)) => {
            print!("{text}");
            return Ok(0);
        }
        Err(usage) => {
            eprint!("{usage}");
            return Ok(2);
        }
    };
    let m = &matches;
    let config = Config::load()?;
    config.apply()?;
    let store = Store::open();
    // A first run at a terminal starts the guided setup instead.
    if bare && init::wanted(&store) {
        init::run(&config, &store, init::Answers::Ask, init::Plan::default()).await?;
        return Ok(0);
    }
    match m.command.name {
        "setup" if !m.value("agent").unwrap_or_default().is_empty() => {
            setup(&config, &store, agent_named(m)?, m.flag("undo")).await?;
        }
        "setup" => {
            if m.flag("undo") {
                bail!("--undo restores one agent: `slopmax setup claude --undo`");
            }
            let answers = if m.flag("yes") || !std::io::stdin().is_terminal() {
                init::Answers::Defaults
            } else {
                init::Answers::Ask
            };
            let plan = init::Plan {
                import: m.value("import").map(init::sources).transpose()?,
                login: m.value("login").map(init::subscriptions).transpose()?,
                keys_from_env: m.flag("keys-from-env"),
                strategy: m
                    .value("strategy")
                    .map(|s| {
                        Strategy::parse(s).with_context(|| {
                            format!("--strategy takes reset-first, fill-first, least-used, or round-robin, got {s:?}")
                        })
                    })
                    .transpose()?,
                affinity: m.value("affinity").map(on_off).transpose()?,
                agents: m.value("agents").map(init::agents).transpose()?,
                no_service: m.flag("no-service"),
            };
            init::run(&config, &store, answers, plan).await?;
        }
        "status" => {
            let args = StatusArgs {
                refresh: m.flag("refresh"),
                watch: m.flag("watch"),
                json: m.flag("json"),
            };
            if args.watch && args.json {
                bail!("--json cannot be combined with --watch");
            }
            status::run(&config, &store, args).await?;
        }
        "login" => {
            let provider: ProviderId = m.get("provider")?;
            let endpoint = match m.value("url") {
                Some(url) => Some(endpoint(url, m.value("dialect"), m.value("models"))?),
                None if provider == ProviderId::Compat => {
                    bail!("a compatible endpoint needs its address: --url <base url>")
                }
                None => None,
            };
            if endpoint.is_some() && provider != ProviderId::Compat {
                bail!("--url, --dialect, and --models are for `slopmax login compat`");
            }
            let options = LoginOptions {
                device: m.flag("device"),
                no_browser: m.flag("no-browser"),
                endpoint,
                ..LoginOptions::default()
            };
            let label = m.value("label").map(str::to_owned);
            login(&config, &store, provider, label, options).await?;
        }
        "import" => import(&config, &store, m.get("source")?, m.flag("own")).await?,
        "own" => own(&config, &store, &m.get::<String>("account")?).await?,
        "use" => use_account(&config, &store, &m.get::<String>("account")?).await?,
        "label" => {
            let label: String = m.get("label")?;
            rename(&config, &store, &m.get::<String>("account")?, label).await?;
        }
        "priority" => {
            let priority: i32 = m.get("priority")?;
            set_priority(&config, &store, &m.get::<String>("account")?, priority).await?;
        }
        "enable" => set_disabled(&config, &store, &m.get::<String>("account")?, false).await?,
        "disable" => set_disabled(&config, &store, &m.get::<String>("account")?, true).await?,
        "remove" => remove(&config, &store, &m.get::<String>("account")?).await?,
        "redeem" => redeem(&config, &store, &m.get::<String>("account")?, m.flag("yes")).await?,
        "serve" => return daemon::run(config).await.map(daemon::Stopped::code),
        "start" => start(&config).await?,
        "stop" => stop(&config).await?,
        "service" => service(&config, &m.get::<String>("action")?).await?,
        "run" => {
            ensure_running(&config).await?;
            return agent::run(agent_named(m)?, &config, &m.rest);
        }
        "env" => {
            let exe = std::env::current_exe().context("locating the slopmax binary")?;
            print!("{}", agent_named(m)?.env(&config, &exe));
        }
        "config" => {
            let name = m.value("name").unwrap_or_default();
            let value = m.value("value").unwrap_or_default();
            settings(&config, name, value).await?;
        }
        "usage" => {
            let by = m.value("by").unwrap_or("day");
            if !matches!(by, "day" | "model" | "account") {
                bail!("--by takes day, model, or account");
            }
            usage::run(
                &config,
                &store,
                &m.get::<String>("range")?,
                by,
                m.flag("json"),
            )?;
        }
        "notify" => {
            if !config.notify.is_enabled() {
                bail!(
                    "notifications are off; set a webhook or command under [notify] in {}",
                    paths::config_file().display()
                );
            }
            let http = auth::http_client(Origins::default());
            let event = notify::Event::test(Timestamp::now());
            config.notify.send(&http, &event).await?;
            println!("Sent a test notification.");
        }
        "key" => key(&config, m.get::<String>("action")?.as_str(), m).await?,
        "logs" => {
            let lines = match m.value("lines") {
                Some(n) => n.parse().context("--lines takes a number")?,
                None => 40,
            };
            background::logs(lines, m.flag("follow")).await?;
        }
        "dashboard" => {
            ensure_running(&config).await?;
            let url = config.dashboard_url();
            if !m.flag("print") && auth::callback::open_browser(&url) {
                println!("Opened the dashboard in your browser.");
            } else {
                println!("Open the dashboard at:\n\n  {url}\n");
                println!(
                    "{}",
                    ui::dim(format!(
                        "On another machine, forward the port first: ssh -L {port}:127.0.0.1:{port} <this host>",
                        port = config.listen.port()
                    ))
                );
            }
        }
        "doctor" => return doctor::run(&config, &store).await,
        "daemon-info" => {
            // What an app needs to reach the proxy, and to tell a daemon it
            // started (this binary) from one another install runs.
            let running = slopmax_client::Client::new(config.base_url(), &config.api_key)
                .health()
                .await
                .map(|h| h.version);
            // The login service, for an app that offers to install it.
            let service = slopmax_core::service::Manager::detect().map(|m| {
                let status = m.status();
                serde_json::json!({ "installed": status.installed, "running": status.running })
            });
            let info = serde_json::json!({
                "base": config.base_url(),
                "key": config.api_key,
                "version": env!("CARGO_PKG_VERSION"),
                "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
                "home": slopmax_core::paths::Home::current().dir().display().to_string(),
                "running": running.is_some(),
                "runningVersion": running,
                "service": service,
            });
            println!("{info}");
        }
        "completions" => print!("{}", args::completions(&APP, m.get("shell")?)),
        name => unreachable!("`{name}` is in the command table but not dispatched"),
    }
    // Setup imports the logins it finds on disk itself: a daemon already
    // running takes them in now, rather than at its next look at the files.
    if m.command.name == "setup"
        && let Some(client) = daemon(&config).await
    {
        let _ = client.sync().await;
    }
    Ok(0)
}

/// The agent named by the `agent` argument.
/// `slopmax key list|add|remove`.
async fn key(config: &Config, action: &str, m: &args::Matches) -> Result<()> {
    use slopmax_client::api::{ApiError, requests::MakeKey, settings::KeyInfo};
    let path = paths::config_file();
    let name = m.value("name").filter(|n| !n.is_empty());
    let client = daemon(config).await;
    match (action, name) {
        ("list", _) => {
            let keys: Vec<KeyInfo> = match &client {
                Some(client) => client.keys().await?,
                None => config
                    .keys
                    .iter()
                    .map(slopmax_core::api::key_info)
                    .collect(),
            };
            if keys.is_empty() {
                println!("No client keys. Make one with `slopmax key add <name>`.");
            }
            for key in &keys {
                let models = if key.models.is_empty() {
                    "any model".to_owned()
                } else {
                    key.models.join(", ")
                };
                println!("{}  {}", ui::bold(&key.name), ui::dim(models));
            }
        }
        ("add", Some(name)) => {
            let models: Vec<String> = m
                .value("models")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            let (key, applied) = match &client {
                Some(client) => {
                    let asked = MakeKey {
                        name: name.to_owned(),
                        models,
                    };
                    (client.make_key(&asked).await?.key, "the proxy takes it now")
                }
                None => (
                    Config::add_key(&path, name, &models)?,
                    "the proxy takes it when it starts",
                ),
            };
            println!("{key}");
            eprintln!(
                "{}",
                ui::dim(format!(
                    "Added the key {name:?}. Clients present it as a bearer token or x-api-key; {applied}."
                ))
            );
        }
        ("remove", Some(name)) => {
            let removed = match &client {
                Some(client) => match client.remove_key(name).await {
                    Ok(_) => true,
                    Err(slopmax_client::Error::Api(ApiError::NotFound { .. })) => false,
                    Err(e) => return Err(e.into()),
                },
                None => Config::remove_key(&path, name)?,
            };
            if !removed {
                bail!("no key named {name:?}");
            }
            println!("Revoked the key {name:?}.");
        }
        (_, None) => bail!("`slopmax key {action}` needs the key's name"),
        _ => unreachable!("key actions are checked by the parser"),
    }
    Ok(())
}

/// A compatible endpoint from `login compat` arguments.
fn endpoint(url: &str, dialect: Option<&str>, models: Option<&str>) -> Result<Endpoint> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        bail!("--url takes an http:// or https:// base URL, got {url:?}");
    }
    let dialect = match dialect.unwrap_or("chat") {
        "chat" => Dialect::Chat,
        "responses" => Dialect::Responses,
        "messages" => Dialect::Messages,
        other => bail!("--dialect takes chat, responses, or messages, got {other:?}"),
    };
    let models = models
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(Endpoint {
        base_url: url.trim_end_matches('/').to_owned(),
        dialect,
        models,
    })
}

/// `slopmax config [name [value]]`: shows the live settings, or one, or
/// sets one and has the running proxy apply it at once.
async fn settings(config: &Config, name: &str, value: &str) -> Result<()> {
    use slopmax_core::config::{LIVE, live_value};
    if name.is_empty() {
        let width = LIVE.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
        for (name, about) in LIVE {
            let current = config.live(name).unwrap_or_default();
            println!(
                "{}  {}  {}",
                ui::pad(name, width),
                ui::bold(ui::pad(&current, 11)),
                ui::dim(about)
            );
        }
        println!(
            "\n{}",
            ui::dim(format!(
                "`slopmax config <name> <value>` changes one; the rest live in {}.",
                paths::config_file().display()
            ))
        );
        return Ok(());
    }
    if value.is_empty() {
        let current = config
            .live(name)
            .with_context(|| live_value(name, "").err().unwrap_or_default())?;
        println!("{current}");
        return Ok(());
    }
    let (now, applied) = match daemon(config).await {
        Some(client) => {
            let patch = slopmax_client::api::settings::LivePatch::parse(name, value)
                .map_err(anyhow::Error::msg)?;
            let view = client.change_settings(&patch).await?;
            let now = view.settings.live.get(name).map(|v| v.text());
            (now.unwrap_or_default(), "applied now")
        }
        None => {
            let setting = live_value(name, value).map_err(anyhow::Error::msg)?;
            let changed = Config::set(&paths::config_file(), &[setting])?;
            let now = changed.live(name).unwrap_or_default();
            (now, "the proxy applies it when it starts")
        }
    };
    println!(
        "{name} = {} {}",
        ui::bold(now),
        ui::dim(format!("({applied})"))
    );
    Ok(())
}

/// The daemon serving this home, if one answers at the address config.toml
/// gives. While it runs it is the only writer of the state, so changes go
/// through it.
pub(super) async fn daemon(config: &Config) -> Option<slopmax_client::Client> {
    let client = slopmax_client::Client::new(config.base_url(), &config.api_key);
    client.health().await.map(|_| client)
}

/// `on` or `off`, as switches are given.
fn on_off(value: &str) -> Result<bool> {
    match value {
        "on" | "true" | "yes" => Ok(true),
        "off" | "false" | "no" => Ok(false),
        _ => bail!("expected on or off, got {value:?}"),
    }
}

fn agent_named(m: &args::Matches) -> Result<&'static dyn Agent> {
    let name: String = m.get("agent")?;
    agent::find(&name).with_context(|| format!("unknown agent {name:?}"))
}

async fn setup(config: &Config, store: &Store, agent: &dyn Agent, undo: bool) -> Result<()> {
    let app = agent.title();
    if undo {
        let path = agent::undo(agent)?;
        println!(
            "Restored {} {}",
            app,
            ui::dim(format!("({})", path.display()))
        );
        return Ok(());
    }
    let path = agent::setup(agent, config)?;
    println!(
        "{app} now uses slopmax {}",
        ui::dim(format!("({})", path.display()))
    );
    println!("{}", ui::dim(agent.setup_note()));
    if !agent::servable(agent, &store.list()?) {
        let provider = agent.provider();
        println!(
            "{} no {} account is connected to serve it; until one is, its requests fail. \
             Add one with `slopmax login {provider}`, or undo with `--undo`.",
            ui::yellow("Note:"),
            provider.spec().title,
        );
    }
    let next = if slopmax_core::background::Daemon::new(config)
        .is_running()
        .await
    {
        "Undo with `--undo`."
    } else {
        "Start the proxy with `slopmax start` (or `slopmax service install`). Undo with `--undo`."
    };
    println!("{}", ui::dim(next));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use slopmax_core::provider::ProviderId;

    #[test]
    fn agent_choices_match_the_registry() {
        let choices: Vec<&str> = AGENTS.iter().map(|c| c.value).collect();
        let registered: Vec<&str> = agent::AGENTS.iter().map(|a| a.id()).collect();
        assert_eq!(choices, registered);
        let providers: Vec<&str> = PROVIDERS.iter().map(|c| c.value).collect();
        let ids: Vec<&str> = ProviderId::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(providers, ids);
    }

    #[test]
    fn every_command_parses_a_typical_invocation() {
        let lines = [
            "init --yes",
            "status --refresh",
            "ls -w",
            "login claude --label work",
            "login codex --device --no-browser",
            "login compat --url http://localhost:11434/v1 --models qwen3-coder,llama4",
            "import cliproxyapi --own",
            "own all",
            "use auto",
            "label 1 work",
            "priority 3 -1",
            "enable 1",
            "disable work",
            "remove me@x.dev",
            "redeem 3 --yes",
            "serve",
            "start",
            "stop",
            "service status",
            "run codex exec -c model=m hi",
            "env claude",
            "setup codex --undo",
            "usage 30d --by model",
            "config strategy round-robin",
            "setup --yes --import none --strategy fill-first --affinity off --agents none",
            "notify",
            "key add laptop --models gpt-*",
            "logs -f -n 100",
            "dashboard --print",
            "doctor",
            "daemon-info --json",
            "completions fish",
        ];
        for line in lines {
            let args = line.split(' ').map(str::to_owned);
            assert!(
                matches!(args::parse(&APP, args), Ok(Parsed::Run(_))),
                "{line}"
            );
        }
        for command in APP.commands {
            assert!(
                lines.iter().any(|l| {
                    let first = l.split(' ').next();
                    first == Some(command.name) || first == command.alias
                }),
                "add a typical `{}` invocation above",
                command.name
            );
        }
    }
}
