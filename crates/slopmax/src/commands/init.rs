//! `slopmax setup`: from nothing to a running proxy, step by step. It
//! connects accounts (importing logins, signing in, or taking API keys),
//! chooses how requests are routed, points the agents at the proxy, and
//! starts it at login.
//!
//! Every question has a flag, so the same setup runs unattended
//! (`--yes`): an agent asked to set slopmax up can do it without a
//! terminal, and a server can be set up from a script.

use std::io::IsTerminal;

use anyhow::{Context, Result, bail};

use super::accounts::login;
use crate::term;
use crate::ui;
use slopmax_core::account::{Endpoint, Store};
use slopmax_core::agent::{self, AGENTS, Agent, Wiring};
use slopmax_core::auth::{LoginOptions, callback};
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::import::{self, Source};
use slopmax_core::net::Origins;
use slopmax_core::provider::{Credential, ProviderId};
use slopmax_core::service::Manager;
use slopmax_core::wire::Dialect;
use slopmax_core::{auth, paths};

/// How the setup answers its questions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answers {
    /// Ask on the terminal, except what the flags already answer.
    Ask,
    /// Never ask: the flags, else the recommended defaults (`--yes`).
    Defaults,
}

impl Answers {
    /// Asks a yes/no question; the recommended answer is `default`.
    fn confirm(self, question: &str, default: bool) -> Result<bool> {
        if self == Self::Defaults {
            return Ok(default);
        }
        Ok(term::confirm(&format!("  {question}"), default)?)
    }
}

/// What the flags decided before the setup starts; what they leave open is
/// asked, or, with `--yes`, takes its default.
#[derive(Default)]
pub struct Plan {
    /// `--import`: where to take logins from.
    pub import: Option<Vec<Source>>,
    /// `--login`: subscriptions to sign in to.
    pub login: Option<Vec<ProviderId>>,
    /// `--keys-from-env`: add the API keys set in ANTHROPIC_API_KEY,
    /// OPENAI_API_KEY, and XAI_API_KEY.
    pub keys_from_env: bool,
    pub strategy: Option<Strategy>,
    pub affinity: Option<bool>,
    /// `--agents`: the agents to point at the proxy; none for an empty list.
    pub agents: Option<Vec<&'static dyn Agent>>,
    /// `--no-service`: don't start slopmax at login.
    pub no_service: bool,
}

/// The environment variable each key provider's key is read from.
const KEY_ENV: &[(ProviderId, &str)] = &[
    (ProviderId::Anthropic, "ANTHROPIC_API_KEY"),
    (ProviderId::OpenAI, "OPENAI_API_KEY"),
    (ProviderId::Xai, "XAI_API_KEY"),
];

/// `claude-code,codex` → sources; `none` → none.
pub fn sources(list: &str) -> Result<Vec<Source>> {
    names(list)
        .map(|name| name.parse().map_err(anyhow::Error::msg))
        .collect()
}

/// `claude,codex` → subscriptions to sign in to.
pub fn subscriptions(list: &str) -> Result<Vec<ProviderId>> {
    names(list)
        .map(|name| {
            let provider: ProviderId = name.parse().map_err(anyhow::Error::msg)?;
            if !provider.spec().is_subscription() {
                bail!(
                    "--login signs in to subscriptions (claude, codex); add {name} keys with --keys-from-env or `slopmax login {name}`"
                );
            }
            Ok(provider)
        })
        .collect()
}

/// `claude,codex` → agents; `none` → none.
pub fn agents(list: &str) -> Result<Vec<&'static dyn Agent>> {
    names(list)
        .map(|name| agent::find(name).with_context(|| format!("unknown agent {name:?}")))
        .collect()
}

fn names(list: &str) -> impl Iterator<Item = &str> {
    list.split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty() && *n != "none")
}

/// Whether `slopmax` alone should start the setup: nothing set up yet and
/// someone at a terminal to answer.
pub fn wanted(store: &Store) -> bool {
    std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal()
        && store.list().is_ok_and(|accounts| accounts.is_empty())
}

pub async fn run(config: &Config, store: &Store, answers: Answers, plan: Plan) -> Result<()> {
    println!(
        "\n{}\n{}",
        ui::bold("slopmax setup"),
        ui::dim("One local endpoint that spreads your agents across your accounts.")
    );

    step("Accounts");
    let missed = accounts(store, answers, &plan).await?;
    let connected = store.list()?;
    if connected.is_empty() {
        // Unattended, finding nothing to pool is a failure the caller must
        // see; at a terminal, the person chose to add nothing yet.
        if answers == Answers::Defaults {
            bail!(
                "no accounts are connected, so there is nothing to proxy. Add one of:\n  \
                 --import claude-code,codex   use the logins Claude Code and Codex have here\n  \
                 --import cliproxyapi         use CLIProxyAPI's logins\n  \
                 --login claude,codex         sign in (a device code for ChatGPT without a browser)\n  \
                 --keys-from-env              add ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY"
            );
        }
        println!(
            "\n  No accounts yet. Run `slopmax setup` again, or add one with `slopmax login claude`\n  or `slopmax login codex`."
        );
        return Ok(());
    }

    step("Routing");
    let config = routing(config, answers, &plan)?;

    step("Agents");
    for agent in AGENTS {
        let named = plan
            .agents
            .as_ref()
            .map(|list| list.iter().any(|a| a.id() == agent.id()));
        if named == Some(false) {
            continue;
        }
        // An agent pointed at slopmax with nothing to serve its own models
        // stops working; unless asked for by name, it is left as it is.
        if !agent::servable(agent, &connected) {
            let title = agent.provider().spec().title;
            if named.is_none() {
                println!(
                    "  {} left as it is: no {title} account to serve it. `slopmax setup {}` wires it once there is one.",
                    agent.title(),
                    agent.id()
                );
                continue;
            }
            println!(
                "  {} {} has no {title} account to serve it yet.",
                ui::yellow("note:"),
                agent.title()
            );
        }
        wire(&config, agent, answers)?;
    }

    step("Background");
    background(&config, answers, &plan).await?;

    println!(
        "\n{} {} behind {}.\n  Restart Claude Code, Codex, and the apps that run them. `slopmax` shows each\n  account's usage, `slopmax dashboard` opens the dashboard, and `slopmax doctor`\n  checks the setup.",
        ui::green("Done."),
        match connected.len() {
            1 => "1 account".to_owned(),
            n => format!("{n} accounts"),
        },
        ui::bold(config.base_url()),
    );
    // Unattended, a part of the setup that was asked for and did nothing is
    // a failure the caller must see, though the rest went through.
    if answers == Answers::Defaults && !missed.is_empty() {
        bail!("set up, but not all that was asked: {}", missed.join("; "));
    }
    Ok(())
}

fn step(title: &str) {
    println!("\n{}", ui::bold(title));
}

/// What each provider is, for choosing which to add.
fn offer(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => "Claude Pro or Max, for Claude Code",
        ProviderId::Codex => "ChatGPT Plus, Pro, or Team, for Codex",
        ProviderId::Anthropic => "an Anthropic API key, billed per token",
        ProviderId::OpenAI => "an OpenAI API key, billed per token",
        ProviderId::Xai => "an xAI API key, for Grok models",
        ProviderId::Compat => "any OpenAI- or Anthropic-compatible endpoint",
    }
}

/// Connects what the plan asks for, or what is chosen at the terminal.
/// Returns what was asked for by flag and added nothing.
async fn accounts(store: &Store, answers: Answers, plan: &Plan) -> Result<Vec<String>> {
    let http = auth::http_client(Origins::default());
    let mut missed = Vec::new();
    match &plan.import {
        Some(sources) => {
            for source in sources {
                let found = import::discover(&http, *source).await;
                if report_saved(import::save(store, found, false)) == 0 {
                    let name = match source {
                        Source::All => "all",
                        Source::ClaudeCode => "claude-code",
                        Source::Codex => "codex",
                        Source::Cliproxyapi => "cliproxyapi",
                    };
                    missed.push(format!("--import {name} found no login to take"));
                }
            }
        }
        None => offer_imports(store, answers, &http).await?,
    }

    if plan.keys_from_env {
        for (provider, var) in KEY_ENV {
            let Some(key) = std::env::var(var).ok().filter(|k| !k.trim().is_empty()) else {
                continue;
            };
            let options = LoginOptions {
                key: Some(key.trim().to_owned()),
                ..LoginOptions::default()
            };
            match auth::connect(store, *provider, None, options, term::sign_in()).await {
                Ok((account, _)) => {
                    println!(
                        "    {} {} {}",
                        ui::green("+"),
                        ui::bold(account.name()),
                        ui::dim(format!("from {var}"))
                    );
                }
                Err(e) => {
                    println!("    {} {var}: {e:#}", ui::yellow("skipped"));
                    missed.push(format!("{var} was not added"));
                }
            }
        }
    }

    let chosen: Vec<ProviderId> = match (&plan.login, answers) {
        (Some(list), _) => list.clone(),
        (None, Answers::Defaults) => Vec::new(),
        (None, Answers::Ask) => {
            let have = store.list()?;
            let options: Vec<(&str, &str)> = ProviderId::ALL
                .iter()
                .map(|p| (p.as_str(), offer(*p)))
                .collect();
            // Subscriptions without an account yet are the usual start.
            let defaults: Vec<usize> = ProviderId::ALL
                .iter()
                .enumerate()
                .filter(|(_, p)| p.spec().is_subscription())
                .filter(|(_, p)| !have.iter().any(|a| a.provider == **p))
                .map(|(i, _)| i)
                .collect();
            println!();
            term::choose_many("  Which accounts will slopmax pool?", &options, &defaults)?
                .into_iter()
                .map(|i| ProviderId::ALL[i])
                .collect()
        }
    };
    let asked = plan.login.is_some();
    for provider in chosen {
        if !add(store, provider, answers).await? && asked {
            missed.push(format!("--login {provider} did not sign in"));
        }
    }
    let connected = store.list()?;
    let mut counts: Vec<String> = Vec::new();
    for provider in ProviderId::ALL {
        let n = connected.iter().filter(|a| a.provider == provider).count();
        if n > 0 {
            counts.push(format!("{n} {}", provider.spec().title));
        }
    }
    if !counts.is_empty() {
        println!("  {} {}", ui::dim("connected:"), counts.join(", "));
    }
    Ok(missed)
}

/// Offers the logins found on this machine: CLIProxyAPI's (linked, so
/// both can run) and the agents' own.
async fn offer_imports(
    store: &Store,
    answers: Answers,
    http: &slopmax_core::net::Client,
) -> Result<()> {
    let cliproxy = import::discover(http, Source::Cliproxyapi).await;
    let found = cliproxy.iter().filter(|f| f.account.is_ok()).count();
    if found > 0 {
        println!(
            "  CLIProxyAPI has {found} account{} here. slopmax can follow them while\n  \
             CLIProxyAPI keeps refreshing, so nothing gets signed out.",
            if found == 1 { "" } else { "s" }
        );
        if answers.confirm("Import them?", true)? {
            report_saved(import::save(store, cliproxy, false));
        }
    }
    for agent in AGENTS {
        let has_accounts = store.list()?.iter().any(|a| a.provider == agent.provider());
        if has_accounts || !agent.has_login() {
            continue;
        }
        let question = format!(
            "Import {}'s own login? (Signing in fresh below avoids sharing its tokens.)",
            agent.title()
        );
        if answers.confirm(&question, false)?
            && let Some(item) = agent.import(http).await
        {
            match item.account {
                Ok(account) => {
                    let (account, _) = store.upsert(account)?;
                    println!("    {} {}", ui::green("+"), ui::bold(account.name()));
                }
                Err(e) => println!("    {} {e:#}", ui::dim("skipped:")),
            }
        }
    }
    Ok(())
}

/// Prints what was imported; returns how many accounts were.
fn report_saved(saved: Vec<import::Saved>) -> usize {
    let mut added = 0;
    for item in saved {
        match item.account {
            Ok((account, _)) => {
                added += 1;
                println!("    {} {}", ui::green("+"), ui::bold(account.name()));
            }
            Err(e) => println!("    {} {e:#}", ui::dim("skipped:")),
        }
    }
    added
}

/// Signs in to `provider`, or takes its key or endpoint; at a terminal,
/// offers to add another of a subscription. Returns whether any was added.
async fn add(store: &Store, provider: ProviderId, answers: Answers) -> Result<bool> {
    let title = provider.spec().title;
    let mut added = false;
    loop {
        println!("\n  {}", ui::bold(title));
        let mut options = LoginOptions::default();
        if let Credential::OAuth { .. } = provider.spec().credential {
            // On a machine without a browser, Codex signs in with a code and
            // Claude by pasting the final URL back.
            let headless = !callback::has_browser();
            options.device = headless && provider.spec().device_login();
            options.no_browser = headless;
        }
        if provider == ProviderId::Compat {
            if answers == Answers::Defaults {
                bail!("a compatible endpoint needs `slopmax login compat --url <base url>`");
            }
            let url = term::ask("  Base URL, e.g. http://localhost:11434/v1:", "")?;
            if url.is_empty() {
                return Ok(added);
            }
            let dialect = term::ask("  Its API: chat, responses, or messages", "chat")?;
            let dialect = match dialect.as_str() {
                "responses" => Dialect::Responses,
                "messages" => Dialect::Messages,
                _ => Dialect::Chat,
            };
            options.endpoint = Some(Endpoint {
                base_url: url.trim_end_matches('/').to_owned(),
                dialect,
                models: Vec::new(),
            });
        }
        match login(store, provider, None, options).await {
            Ok(()) => added = true,
            Err(e) => println!("    {} {e:#}", ui::yellow("not added:")),
        }
        let more = provider.spec().is_subscription()
            && answers == Answers::Ask
            && term::confirm(&format!("  Add another {title} account?"), false)?;
        if !more {
            return Ok(added);
        }
    }
}

/// Chooses the strategy and session affinity, and writes them to the
/// config if they changed.
fn routing(config: &Config, answers: Answers, plan: &Plan) -> Result<Config> {
    let strategy = match (plan.strategy, answers) {
        (Some(strategy), _) => strategy,
        (None, Answers::Defaults) => config.strategy,
        (None, Answers::Ask) => {
            let options: Vec<(String, &str)> = Strategy::ALL
                .iter()
                .map(|s| (s.to_string(), s.summary()))
                .collect();
            let options: Vec<(&str, &str)> =
                options.iter().map(|(n, h)| (n.as_str(), *h)).collect();
            let current = Strategy::ALL
                .iter()
                .position(|s| *s == config.strategy)
                .unwrap_or(0);
            Strategy::ALL[term::choose(
                "  How should a new session pick its account?",
                &options,
                current,
            )?]
        }
    };
    let affinity = match plan.affinity {
        Some(affinity) => affinity,
        None => answers.confirm(
            "Keep each session on the account it started on, so its prompt cache stays warm?",
            config.session_affinity,
        )?,
    };
    println!(
        "  {} {strategy}, {}",
        ui::dim("routing:"),
        if affinity {
            "sessions keep their account"
        } else {
            "every request placed afresh"
        }
    );
    if strategy == config.strategy && affinity == config.session_affinity {
        return Ok(config.clone());
    }
    let mut changed = Config::set(
        &paths::config_file(),
        &[
            ("strategy", strategy.to_string().into()),
            ("session_affinity", affinity.into()),
        ],
    )?;
    // The address may come from the environment, not the file.
    changed.listen = config.listen;
    Ok(changed)
}

fn wire(config: &Config, agent: &dyn Agent, answers: Answers) -> Result<()> {
    let replacing = match agent::wiring(agent, config) {
        Wiring::Slopmax => {
            println!("  {} already uses slopmax.", agent.title());
            return Ok(());
        }
        Wiring::Elsewhere(target) => format!(
            " (it uses {target} now; `slopmax setup {} --undo` restores that)",
            agent.id()
        ),
        Wiring::Direct => String::new(),
    };
    let question = format!("Point {} at slopmax?{replacing}", agent.title());
    if answers.confirm(&question, true)? {
        let file = agent::setup(agent, config)?;
        println!("    {} {}", ui::green("wired"), ui::dim(file.display()));
        println!("    {}", ui::dim(agent.setup_note()));
    }
    Ok(())
}

async fn background(config: &Config, answers: Answers, plan: &Plan) -> Result<()> {
    if Daemon::new(config).is_running().await {
        println!("  The proxy is running on {}.", config.base_url());
    }
    let manager = Manager::detect();
    let installed = manager.is_some_and(|m| m.status().installed);
    let exe = background::current_exe()?;
    match manager {
        Some(manager) if !installed && !plan.no_service => {
            if answers.confirm("Start slopmax at login?", true)? {
                let file = background::install_service(config, manager, &exe).await?;
                println!("    {} {}", ui::green("installed"), ui::dim(file.display()));
            }
        }
        Some(_) if installed => println!("  slopmax starts at login."),
        Some(_) => {}
        None => println!(
            "  {}",
            ui::dim(
                "No login service here: the proxy runs until it is stopped; `slopmax start` brings it back."
            )
        ),
    }
    if background::ensure_running(config, &exe).await? {
        println!(
            "  The proxy is running on {} {}",
            config.base_url(),
            ui::dim(format!("(log: {})", paths::log_file().display()))
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_read_as_flags_give_them() {
        assert_eq!(
            sources("claude-code, codex").unwrap(),
            [Source::ClaudeCode, Source::Codex]
        );
        assert!(sources("none").unwrap().is_empty());
        assert!(sources("dropbox").is_err());
        assert_eq!(
            subscriptions("claude,codex").unwrap(),
            [ProviderId::Claude, ProviderId::Codex]
        );
        let refused = subscriptions("openai").unwrap_err().to_string();
        assert!(refused.contains("--keys-from-env"), "{refused}");
        let ids: Vec<&str> = agents("codex").unwrap().iter().map(|a| a.id()).collect();
        assert_eq!(ids, ["codex"]);
        assert!(agents("none").unwrap().is_empty());
        assert!(agents("cursor").is_err());
    }
}
