//! The commands: their table, and running the one asked for.

mod accounts;
mod background;
mod doctor;
mod init;
mod remote;
mod status;
mod tailscale;
mod update;
mod usage;

use std::io::IsTerminal;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use self::accounts::{
    import, login, order, own, redeem, remove, rename, set_disabled, set_priority, use_account,
};
use self::background::{ensure_running, service, start, stop};
use crate::args::{self, App, Arg, Choice, Command, Kind, Parsed};
use crate::ui;
use slopmax_core::account::{Endpoint, Store};
use slopmax_core::agent::{self, Agent};
use slopmax_core::auth::{self, LoginOptions};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::net::Origins;
use slopmax_core::notify;
use slopmax_core::provider::ProviderId;
use slopmax_core::time::Timestamp;
use slopmax_core::wire::Dialect;
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
        value: "grok",
        help: "SuperGrok, used by Grok Build",
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
    Choice {
        value: "grok",
        help: "Grok Build",
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

const TAILSCALE_ACTIONS: &[Choice] = &[
    Choice {
        value: "status",
        help: "Show whether slopmax is published to your tailnet, and who uses it",
    },
    Choice {
        value: "on",
        help: "Publish slopmax to your own machines with `tailscale serve`",
    },
    Choice {
        value: "off",
        help: "Stop publishing it",
    },
    Choice {
        value: "users",
        help: "Tailnet logins whose machines use it without a key",
    },
    Choice {
        value: "admins",
        help: "Machines that may also manage it",
    },
];

const LIST_OPS: &[Choice] = &[
    Choice {
        value: "list",
        help: "Show them",
    },
    Choice {
        value: "add",
        help: "Add one",
    },
    Choice {
        value: "remove",
        help: "Remove one",
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
    about: "Multi-account switcher and proxy for Claude Code, Codex, and Grok Build",
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
                    "own",
                    "With --import cliproxyapi: refresh its logins here instead of following its files",
                    Kind::Flag(None),
                ),
                arg(
                    "login",
                    "Sign in to these subscriptions: claude, codex, grok",
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
                    "Point these agents at the proxy: claude, codex, grok, or none",
                    Kind::Value(None, "AGENTS"),
                ),
                arg(
                    "no-service",
                    "Don't start slopmax at login",
                    Kind::Flag(None),
                ),
                arg(
                    "hub",
                    "Use the slopmax on another of your machines: its name, host[:port], or URL; off goes back",
                    Kind::Value(None, "HUB"),
                ),
                arg(
                    "find-hub",
                    "Look for slopmax on your tailnet, and use it",
                    Kind::Flag(None),
                ),
                arg(
                    "key",
                    "With --hub: a key from the hub (else $SLOPMAX_HUB_KEY)",
                    Kind::Value(None, "KEY"),
                ),
                arg(
                    "name",
                    "With --hub and the hub's owner key: the name of the key made for this machine",
                    Kind::Value(None, "NAME"),
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
        command(
            "order",
            "Show or set the order new sessions use accounts in",
            &[arg(
                "accounts",
                "Accounts to use first, in order: numbers from `slopmax order`, ids, emails, or labels",
                Kind::Rest,
            )],
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
        command(
            "update",
            "Install the newest slopmax and move the running proxy to it",
            &[arg(
                "check",
                "Only say whether a newer release is out",
                Kind::Flag(None),
            )],
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
                    "Group by day, model, account, or machine",
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
        command(
            "tailscale",
            "Share slopmax with your own machines over Tailscale",
            &[
                arg(
                    "action",
                    "What to do",
                    Kind::Optional(TAILSCALE_ACTIONS, "status"),
                ),
                arg(
                    "op",
                    "With users or admins: what to do",
                    Kind::Optional(LIST_OPS, "list"),
                ),
                arg(
                    "name",
                    "With users or admins: the login (you@github) or machine, comma-separated",
                    Kind::Optional(&[], ""),
                ),
                arg(
                    "port",
                    "With on: the port to serve on (default: the proxy's)",
                    Kind::Value(None, "N"),
                ),
                arg(
                    "user",
                    "With on: a tailnet login to let in without a key (repeatable)",
                    Kind::Value(None, "LOGIN"),
                ),
                arg(
                    "admin",
                    "With on: a machine that may also manage slopmax (repeatable)",
                    Kind::Value(None, "MACHINE"),
                ),
                arg(
                    "loopback",
                    "With on: serve the proxy's bare port, where every machine needs a key",
                    Kind::Flag(None),
                ),
                arg(
                    "socket",
                    "With on: serve the proxy's socket, which Tailscale lets only root publish",
                    Kind::Flag(None),
                ),
                arg(
                    "json",
                    "With status: print machine-readable JSON",
                    Kind::Flag(None),
                ),
            ],
        ),
        command("doctor", "Check the setup and say how to fix problems", &[]),
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
    if m.command.name == "completions" {
        print!("{}", args::completions(&APP, m.get("shell")?));
        return Ok(0);
    }
    // A config.toml that does not read stops every command but those that
    // inspect or stop the proxy, or set the setting that broke it: they
    // make do with what of it reads.
    let (config, broken) = match Config::load(home()) {
        Ok(config) => (config, None),
        Err(error)
            if matches!(m.command.name, "stop" | "logs" | "doctor")
                || m.command.name == "config"
                    && m.value("value").is_some_and(|v| !v.is_empty()) =>
        {
            if m.command.name != "doctor" {
                eprintln!("{} {error}", ui::yellow("warning:"));
            }
            (Config::salvage(home()), Some(error))
        }
        Err(error) => return Err(error.into()),
    };
    if broken.is_none() {
        config.apply()?;
    }
    let store = Store::of(home());
    // A first run at a terminal starts the guided setup instead.
    if bare && init::wanted(&config, &store) {
        let plan = init::Plan {
            discover: true,
            ..init::Plan::default()
        };
        init::run(&config, &store, init::Answers::Ask, plan).await?;
        return Ok(0);
    }
    let result = dispatch(m, config.clone(), &store, broken).await;
    match (result, config.hub_url()) {
        (Err(e), Some(url)) => Err(from_hub(e, url, m.command.name)),
        (result, _) => result,
    }
}

/// Runs the command `m` asks for.
async fn dispatch(
    m: &args::Matches,
    config: Config,
    store: &Store,
    broken: Option<slopmax_core::error::ConfigError>,
) -> Result<i32> {
    let store = store.clone();
    // What runs or changes this machine's own proxy, which a machine that
    // uses a hub has none of.
    let action = m.value("action").unwrap_or_default();
    let refused = matches!(m.command.name, "start" | "serve" | "import" | "own")
        || (m.command.name == "service" && action == "install");
    if refused && let Some(refusal) = config.hub_refusal() {
        bail!(refusal);
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
                own: m.flag("own"),
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
                affinity: m
                    .value("affinity")
                    .map(|v| on_off("--affinity", v))
                    .transpose()?,
                agents: m.value("agents").map(init::agents).transpose()?,
                no_service: m.flag("no-service"),
                hub: if m.flag("find-hub") {
                    Some(String::new())
                } else {
                    m.value("hub").map(str::to_owned)
                },
                key: m.value("key").map(str::to_owned),
                name: m.value("name").map(str::to_owned),
                discover: false,
            };
            // A new machine set up at a terminal, with nothing else asked
            // for, is offered a hub on the tailnet first.
            let plan = init::Plan {
                discover: plan.hub.is_none()
                    && plan.import.is_none()
                    && plan.login.is_none()
                    && plan.agents.is_none()
                    && !plan.keys_from_env
                    && !plan.own
                    && init::wanted(&config, &store),
                ..plan
            };
            if plan.hub.is_none() && (plan.key.is_some() || plan.name.is_some()) {
                bail!(
                    "--key and --name go with --hub: `slopmax setup --hub <machine> --key <key>`"
                );
            }
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
            let priority: i32 = m.whole("priority", "2 or -1")?.unwrap_or_default();
            set_priority(&config, &store, &m.get::<String>("account")?, priority).await?;
        }
        "order" => order(&config, &store, &m.rest).await?,
        "enable" => set_disabled(&config, &store, &m.get::<String>("account")?, false).await?,
        "disable" => set_disabled(&config, &store, &m.get::<String>("account")?, true).await?,
        "remove" => remove(&config, &store, &m.get::<String>("account")?).await?,
        "redeem" => redeem(&config, &store, &m.get::<String>("account")?, m.flag("yes")).await?,
        "serve" => {
            let stopped = daemon::run(config, home().clone()).await?;
            return Ok(stopped.finish().await);
        }
        "update" => return update::run(&config, m.flag("check")).await,
        "start" => start(&config).await?,
        "stop" => stop(&config).await?,
        "service" => service(&config, &m.get::<String>("action")?).await?,
        "run" => {
            let agent = agent_named(m)?;
            // Before the proxy starts: it would be left running for nothing.
            agent::installed(agent, &config, home())?;
            if config.hub.is_some() {
                // The hub must answer; nothing runs here.
                daemon(&config).await?;
            } else {
                ensure_running(&config).await?;
            }
            return agent::run(agent, &config, home(), &m.rest);
        }
        "env" => {
            let exe = std::env::current_exe().context("locating the slopmax binary")?;
            print!("{}", agent_named(m)?.env(&config, home(), &exe));
        }
        "config" => {
            let name = m.value("name").unwrap_or_default();
            let value = m.value("value").unwrap_or_default();
            settings(&config, name, value).await?;
        }
        "usage" => {
            let by = m.value("by").unwrap_or("day");
            if !matches!(by, "day" | "model" | "account" | "machine") {
                bail!("--by takes day, model, account, or machine");
            }
            usage::run(
                &config,
                &store,
                &m.get::<String>("range")?,
                by,
                m.flag("json"),
            )
            .await?;
        }
        "notify" if config.hub.is_some() => {
            if let Some(client) = daemon(&config).await? {
                client.notify_test().await?;
            }
            println!("The hub sent a test notification.");
        }
        "notify" => {
            if !config.notify.is_enabled() {
                bail!(
                    "notifications are off; set a webhook or command under [notify] in {}",
                    home().config().display()
                );
            }
            let http = auth::http_client(Origins::default());
            let event = notify::Event::test(Timestamp::now());
            config.notify.send(&http, &event).await?;
            println!("Sent a test notification.");
        }
        "key" => key(&config, m.get::<String>("action")?.as_str(), m).await?,
        "logs" => {
            if let (Some(refusal), Some(url)) = (config.hub_refusal(), config.hub_url()) {
                bail!(
                    "{refusal} The hub's log is on {}: run `slopmax logs` there.",
                    remote::host_name(url)
                );
            }
            let lines = m.whole("lines", "100")?.unwrap_or(40);
            background::logs(lines, m.flag("follow")).await?;
        }
        "dashboard" => {
            let url = if config.hub.is_some() {
                // The hub must answer; its dashboard asks for no key.
                daemon(&config).await?;
                format!("{}/slopmax/", config.agent_base())
            } else {
                ensure_running(&config).await?;
                config.dashboard_url()
            };
            if !m.flag("print") && auth::callback::open_browser(&url) {
                println!("Opened the dashboard in your browser.");
            } else {
                println!("Open the dashboard at:\n\n  {url}\n");
                if config.hub.is_none() {
                    println!("{}", ui::dim(tailscale::dashboard_hint(&config).await));
                }
            }
        }
        "tailscale" => {
            let port = m.whole::<u16>("port", "7567")?;
            let args = tailscale::Args {
                action: m.value("action").unwrap_or("status"),
                op: m.value("op").unwrap_or("list"),
                name: m.value("name").unwrap_or_default(),
                port,
                users: m.values("user"),
                admins: m.values("admin"),
                loopback: m.flag("loopback"),
                socket: m.flag("socket"),
                json: m.flag("json"),
            };
            tailscale::run(&config, args).await?;
        }
        "doctor" => return doctor::run(&config, &store, broken.as_ref()).await,
        "completions" => unreachable!("answered before the config is read"),
        name => unreachable!("`{name}` is in the command table but not dispatched"),
    }
    // Setup imports the logins it finds on disk itself: a daemon already
    // running takes them in now, rather than at its next look at the files.
    let hub_setup = m.flag("find-hub") || m.value("hub").is_some();
    if m.command.name == "setup"
        && config.hub.is_none()
        && !hub_setup
        && let Ok(Some(client)) = daemon(&config).await
    {
        let _ = client.sync().await;
    }
    Ok(0)
}

/// An error from a command run against the hub, as the hub's refusal reads
/// to this machine's user.
fn from_hub(e: anyhow::Error, url: &str, command: &str) -> anyhow::Error {
    use slopmax_client::api::ApiError;
    let Some(error) = e
        .chain()
        .find_map(|c| c.downcast_ref::<slopmax_client::Error>())
    else {
        return e;
    };
    let url = url.trim_end_matches('/');
    match error {
        // The daemon's 403 to a machine allowed less than the command
        // needs, naming the machine.
        slopmax_client::Error::Api(ApiError::Unauthorized { message })
            if message.starts_with("this machine may ") =>
        {
            let machine = message
                .rsplit_once("admins add ")
                .map(|(_, machine)| machine.trim())
                .filter(|m| !m.is_empty() && *m != "<machine>")
                .map(str::to_owned)
                .or_else(|| hub_health().and_then(|h| h.machine.clone()))
                .unwrap_or_else(|| "<this machine>".to_owned());
            let may = if message.contains("may not change") {
                "may use the hub but not change it"
            } else {
                "may use the hub but not see its accounts"
            };
            anyhow::anyhow!(
                "This machine {may}. On the hub: slopmax tailscale admins add {machine}"
            )
        }
        // The daemon's 403 to a client key, which reaches its proxy only.
        slopmax_client::Error::Api(ApiError::Unauthorized { message })
            if message.contains("reaches the proxy only") =>
        {
            anyhow::anyhow!(
                "the hub at {url} takes this machine's key for its agents only, not for \
                 `slopmax {command}`; run it on the hub"
            )
        }
        slopmax_client::Error::Api(ApiError::Unauthorized { message })
            if !message.contains("hub") =>
        {
            anyhow::anyhow!(
                "the hub at {url} doesn't take this machine: {message}. `slopmax setup --hub {url}` \
                 sets it up again."
            )
        }
        _ => e,
    }
}

/// What the hub said of itself and of this machine, once [`daemon`] heard
/// it.
pub(super) fn hub_health() -> Option<&'static slopmax_client::Health> {
    HUB.get()
}

static HUB: OnceLock<slopmax_client::Health> = OnceLock::new();

/// `slopmax key list|add|remove`.
async fn key(config: &Config, action: &str, m: &args::Matches) -> Result<()> {
    use slopmax_client::api::{ApiError, requests::MakeKey, settings::KeyInfo};
    let path = home().config();
    let name = m.value("name").filter(|n| !n.is_empty());
    let client = daemon(config).await?;
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
            if config.hub.is_none()
                && let Some((url, _)) = tailscale::published_url(config).await
            {
                eprintln!(
                    "{}",
                    ui::dim(format!(
                        "On that machine: slopmax setup --hub {url} --key {key}"
                    ))
                );
            }
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
/// sets one and has the running proxy apply it at once. Settings go by
/// their config.toml names (the API's names work too), and messages use
/// the name as typed.
async fn settings(config: &Config, name: &str, value: &str) -> Result<()> {
    use slopmax_client::api::settings::{LIVE, LivePatch};
    let path = home().config();
    // A machine that uses a hub shows the hub's settings.
    let shown = if config.hub.is_some() && value.is_empty() && name != "listen" {
        match daemon(config).await? {
            Some(client) => Some(client.settings().await?.settings),
            None => None,
        }
    } else {
        None
    };
    let current = |config: &Config, name: &str| {
        let settings = match &shown {
            Some(settings) => settings.clone(),
            None => slopmax_core::api::settings(config),
        };
        settings
            .live
            .get(name)
            .map(|v| v.text())
            .unwrap_or_default()
    };
    let rest = if config.hub.is_some() {
        "the hub's config.toml".to_owned()
    } else {
        path.display().to_string()
    };
    if name.is_empty() {
        let width = LIVE.iter().map(|l| l.toml.len()).max().unwrap_or(0);
        for live in LIVE {
            println!(
                "{}  {}  {}",
                ui::pad(live.toml, width),
                ui::bold(ui::pad(&current(config, live.toml), 11)),
                ui::dim(live.summary)
            );
        }
        println!(
            "\n{}",
            ui::dim(format!(
                "`slopmax config <name> <value>` changes one; the rest live in {rest}."
            ))
        );
        return Ok(());
    }
    // Where the proxy listens is read once, as it starts.
    if name == "listen" {
        let from = if std::env::var_os("SLOPMAX_LISTEN").is_some_and(|v| !v.is_empty()) {
            "set by SLOPMAX_LISTEN".to_owned()
        } else {
            format!("set in {}", path.display())
        };
        if value.is_empty() {
            println!(
                "listen = {} {}",
                ui::bold(config.listen.to_string()),
                ui::dim(format!("({from}; restart the proxy after changing it)"))
            );
            return Ok(());
        }
        bail!(
            "`slopmax config` can't change listen: set it in {}, then restart the proxy (`slopmax stop`, then `slopmax start`)",
            path.display()
        );
    }
    if value.is_empty() {
        // Checks the name, with the same message a change would give.
        if slopmax_client::api::settings::live(name).is_none() {
            LivePatch::parse(name, "").map_err(anyhow::Error::msg)?;
        }
        println!("{}", current(config, name));
        return Ok(());
    }
    let patch = LivePatch::parse(name, value).map_err(anyhow::Error::msg)?;
    let (now, applied) = match daemon(config).await? {
        Some(client) => {
            let view = client.change_settings(&patch).await?;
            let now = view.settings.live.get(name).map(|v| v.text());
            (now.unwrap_or_default(), "applied now")
        }
        None => {
            let values: Vec<_> = patch
                .changes()
                .into_iter()
                .map(|(live, value)| (live.toml, slopmax_core::api::toml_value(value)))
                .collect();
            let changed = Config::set(&path, &values)?;
            (
                current(&changed, name),
                "the proxy applies it when it starts",
            )
        }
    };
    println!(
        "{name} = {} {}",
        ui::bold(now),
        ui::dim(format!("({applied})"))
    );
    Ok(())
}

/// The home this process works in: made once, from the environment, and
/// handed to the engine, which reads no environment of its own.
pub(super) fn home() -> &'static slopmax_core::paths::Home {
    static HOME: std::sync::OnceLock<slopmax_core::paths::Home> = std::sync::OnceLock::new();
    HOME.get_or_init(slopmax_core::paths::Home::current)
}

/// The daemon serving this home, if one answers at the address config.toml
/// gives. While it runs it is the only writer of the state, so changes go
/// through it.
///
/// A proxy on that address that refuses this home's key (one started from
/// another home) is an error: changes made here would never reach it.
///
/// A machine that uses a hub goes to the hub instead, and only to it: a hub
/// that doesn't answer is an error, never a reason to read this machine's
/// files.
pub(super) async fn daemon(config: &Config) -> Result<Option<slopmax_client::Client>> {
    if config.hub.is_some() {
        let url = config.agent_base();
        let client = slopmax_client::Client::remote(&url, config.agent_token());
        return match client.health_within(Duration::from_secs(10)).await {
            Some(health) => {
                let _ = HUB.set(health);
                Ok(Some(client))
            }
            None => bail!(remote::unreachable(&url).await),
        };
    }
    let client = slopmax_client::Client::new(config.base_url(), &config.api_key);
    // One on this machine answers at once.
    match client
        .health_within(std::time::Duration::from_secs(1))
        .await
    {
        None => Ok(None),
        Some(health) if health.owner == Some(false) => {
            bail!(slopmax_core::background::foreign(config.listen, health.pid))
        }
        Some(_) => Ok(Some(client)),
    }
}

/// `on` or `off`, as the switch `flag` is given.
fn on_off(flag: &str, value: &str) -> Result<bool> {
    match value {
        "on" | "true" | "yes" => Ok(true),
        "off" | "false" | "no" => Ok(false),
        _ => bail!("{flag} takes on or off, got {value:?}"),
    }
}

/// The agent named by the `agent` argument.
fn agent_named(m: &args::Matches) -> Result<&'static dyn Agent> {
    let name: String = m.get("agent")?;
    agent::find(&name).with_context(|| format!("unknown agent {name:?}"))
}

async fn setup(config: &Config, store: &Store, agent: &dyn Agent, undo: bool) -> Result<()> {
    let app = agent.title();
    if undo {
        let path = agent::undo(agent, home())?;
        println!(
            "Restored {} {}",
            app,
            ui::dim(format!("({})", path.display()))
        );
        return Ok(());
    }
    let path = agent::setup(agent, config, home())?;
    if let Some(url) = config.hub_url() {
        println!(
            "{app} now uses the hub at {} {}",
            url.trim_end_matches('/'),
            ui::dim(format!("({})", path.display()))
        );
        println!("{}", ui::dim(agent.setup_note()));
        println!(
            "{}",
            ui::dim(format!("Undo with `slopmax setup {} --undo`.", agent.id()))
        );
        return Ok(());
    }
    println!(
        "{app} now uses slopmax {}",
        ui::dim(format!("({})", path.display()))
    );
    println!("{}", ui::dim(agent.setup_note()));
    if !agent::servable(agent, &store.list()?) {
        let provider = agent.provider();
        println!(
            "{} no {} account is connected to serve it; until one is, its requests fail. \
             Add one with `slopmax login {provider}`.",
            ui::yellow("Note:"),
            provider.spec().title,
        );
    }
    let undo = format!("Undo with `slopmax setup {} --undo`.", agent.id());
    let next = if slopmax_core::background::Daemon::new(config)
        .is_running()
        .await
    {
        undo
    } else {
        format!("Start the proxy with `slopmax start` (or `slopmax service install`). {undo}")
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
            "order 2 work",
            "order",
            "enable 1",
            "disable work",
            "remove me@x.dev",
            "redeem 3 --yes",
            "update --check",
            "serve",
            "start",
            "stop",
            "service status",
            "run codex exec -c model=m hi",
            "env claude",
            "setup codex --undo",
            "usage 30d --by model",
            "usage 7d --by machine",
            "config strategy round-robin",
            "setup --yes --import none --strategy fill-first --affinity off --agents none",
            "setup --hub hub --key sm-x --name laptop --yes",
            "setup --hub=",
            "setup --find-hub",
            "setup --hub off",
            "tailscale",
            "tailscale on --port 7600 --user me@github --user you@github --admin mac --loopback",
            "tailscale on --socket",
            "tailscale off",
            "tailscale status --json",
            "tailscale users add me@github",
            "tailscale admins remove mac",
            "notify",
            "key add laptop --models gpt-*",
            "logs -f -n 100",
            "dashboard --print",
            "doctor",
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

    #[test]
    fn the_hub_s_refusals_say_what_this_machine_may_do() {
        use slopmax_client::api::ApiError;
        let refused = |message: &str, command: &str| {
            let e = anyhow::Error::new(slopmax_client::Error::Api(ApiError::Unauthorized {
                message: message.to_owned(),
            }));
            from_hub(e, "https://hub.example.ts.net:7567/", command).to_string()
        };
        assert_eq!(
            refused(
                "this machine may not change slopmax; on the hub: slopmax tailscale admins add mac",
                "use"
            ),
            "This machine may use the hub but not change it. On the hub: slopmax tailscale admins \
             add mac"
        );
        assert_eq!(
            refused(
                "the key \"ci\" reaches the proxy only, not slopmax's own API",
                "status"
            ),
            "the hub at https://hub.example.ts.net:7567 takes this machine's key for its agents \
             only, not for `slopmax status`; run it on the hub"
        );
    }
}
