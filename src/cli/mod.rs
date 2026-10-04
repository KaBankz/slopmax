//! Command-line interface.

mod accounts;
mod args;
mod background;
mod doctor;
mod init;
mod usage;

use anyhow::{Context, Result, bail};

use self::accounts::{import, login, own, redeem, remove, set_disabled, status, use_account};
use self::args::{App, Arg, Choice, Command, Kind, Parsed};
use self::background::{ensure_running, service, start, stop};
use crate::account::{Endpoint, Store};
use crate::agent::{self, Agent};
use crate::auth::{self, LoginOptions};
use crate::config::Config;
use crate::net::Origins;
use crate::net::client::Proxy;
use crate::provider::ProviderId;
use crate::time::Timestamp;
use crate::wire::Dialect;
use crate::{daemon, notify, paths, ui};

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
        command(
            "init",
            "Set up accounts, agents, and the background service, step by step",
            &[arg(
                "yes",
                "Take every recommended answer without asking",
                Kind::Flag(Some('y')),
            )],
        ),
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
            "Redeem a banked reset credit, resetting a ChatGPT account's limits",
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
            "setup",
            "Point an agent's own config at the proxy (or restore it)",
            &[
                arg("agent", "Which agent", Kind::Required(AGENTS)),
                arg("undo", "Restore what setup replaced", Kind::Flag(None)),
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
    if let Some(proxy) = &config.proxy {
        let proxy = Proxy::parse(proxy).map_err(|e| anyhow::anyhow!("config `proxy`: {e}"))?;
        Proxy::set_default(proxy);
    }
    let store = Store::open();
    // A first run at a terminal starts the guided setup instead.
    if bare && init::wanted(&store) {
        init::run(&config, &store, init::Answers::Ask).await?;
        return Ok(0);
    }
    match m.command.name {
        "init" => {
            let answers = if m.flag("yes") {
                init::Answers::Defaults
            } else {
                init::Answers::Ask
            };
            init::run(&config, &store, answers).await?;
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
            status(&config, &store, args).await?;
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
            };
            let label = m.value("label").map(str::to_owned);
            login(&store, provider, label, options).await?;
        }
        "import" => import(&store, m.get("source")?, m.flag("own")).await?,
        "own" => own(&store, &m.get::<String>("account")?)?,
        "use" => use_account(&store, &m.get::<String>("account")?)?,
        "label" => {
            let id = store.find(&m.get::<String>("account")?)?.id;
            let label: String = m.get("label")?;
            let a = store.update(&id, |a| a.label = Some(label))?;
            println!("Renamed {} to {}", a.id, ui::bold(a.name()));
        }
        "priority" => {
            let id = store.find(&m.get::<String>("account")?)?.id;
            let priority: i32 = m.get("priority")?;
            let a = store.update(&id, |a| a.priority = priority)?;
            println!("{} now has priority {priority}", ui::bold(a.name()));
        }
        "enable" => set_disabled(&store, &m.get::<String>("account")?, false)?,
        "disable" => set_disabled(&store, &m.get::<String>("account")?, true)?,
        "remove" => remove(&store, &m.get::<String>("account")?)?,
        "redeem" => redeem(&config, &store, &m.get::<String>("account")?, m.flag("yes")).await?,
        "serve" => daemon::run(config).await?,
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
        "setup" => setup(&config, agent_named(m)?, m.flag("undo"))?,
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
        "dashboard" => {
            ensure_running(&config).await?;
            // The key travels in the fragment, which browsers do not send.
            let url = format!(
                "{}/slopmax/dashboard#key={}",
                config.base_url(),
                config.api_key
            );
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
        "completions" => print!("{}", args::completions(&APP, m.get("shell")?)),
        name => unreachable!("`{name}` is in the command table but not dispatched"),
    }
    Ok(0)
}

/// The agent named by the `agent` argument.
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

fn agent_named(m: &args::Matches) -> Result<&'static dyn Agent> {
    let name: String = m.get("agent")?;
    agent::find(&name).with_context(|| format!("unknown agent {name:?}"))
}

fn setup(config: &Config, agent: &dyn Agent, undo: bool) -> Result<()> {
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
    println!(
        "{}",
        ui::dim(
            "Start the proxy with `slopmax start` (or `slopmax service install`). Undo with `--undo`."
        )
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderId;

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
            "notify",
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
}
