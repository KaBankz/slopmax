//! `slopmax init`: the guided first run. It connects accounts (importing
//! CLIProxyAPI's or signing in), points the agents at the proxy, and starts
//! it at login, asking before each step.

use std::io::IsTerminal;

use anyhow::Result;

use super::accounts::login;
use crate::term;
use crate::ui;
use slopmax_core::account::Store;
use slopmax_core::agent::{self, AGENTS, Agent, Wiring};
use slopmax_core::auth::{LoginOptions, callback};
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::Config;
use slopmax_core::import::{self, Source};
use slopmax_core::net::Origins;
use slopmax_core::provider::ProviderId;
use slopmax_core::service::Manager;
use slopmax_core::{auth, paths};

/// How the wizard answers its questions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answers {
    /// Ask on the terminal.
    Ask,
    /// Take every recommended default (`--yes`).
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

/// Whether `slopmax` alone should start the wizard: nothing set up yet and
/// someone at a terminal to answer.
pub fn wanted(store: &Store) -> bool {
    std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal()
        && store.list().is_ok_and(|accounts| accounts.is_empty())
}

pub async fn run(config: &Config, store: &Store, answers: Answers) -> Result<()> {
    println!(
        "\n{}\n{}",
        ui::bold("slopmax setup"),
        ui::dim("One local proxy that spreads Claude Code and Codex across your accounts.")
    );

    step("Accounts");
    accounts(store, answers).await?;
    if store.list()?.is_empty() {
        println!(
            "\n  No accounts yet. Add one any time with `slopmax login claude` or `slopmax login codex`."
        );
        return Ok(());
    }

    step("Agents");
    for agent in AGENTS {
        wire(config, agent, answers)?;
    }

    step("Background");
    background(config, answers).await?;

    println!(
        "\n{} Restart Claude Code, Codex, and the apps that run them. `slopmax` shows each\n  account's usage; `slopmax doctor` checks the setup.",
        ui::green("Done.")
    );
    Ok(())
}

fn step(title: &str) {
    println!("\n{}", ui::bold(title));
}

async fn accounts(store: &Store, answers: Answers) -> Result<()> {
    let http = auth::http_client(Origins::default());
    let cliproxy = import::discover(&http, Source::Cliproxyapi).await;
    let found = cliproxy.iter().filter(|f| f.account.is_ok()).count();
    if found > 0 {
        println!(
            "  CLIProxyAPI has {found} account{} here. slopmax can follow them while\n  \
             CLIProxyAPI keeps refreshing, so nothing gets signed out.",
            if found == 1 { "" } else { "s" }
        );
        if answers.confirm("Import them?", true)? {
            for saved in import::save(store, cliproxy, false) {
                if let Ok((account, _)) = saved.account {
                    println!("    {} {}", ui::green("+"), ui::bold(account.name()));
                }
            }
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
            && let Some(item) = agent.import(&http).await
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

    if answers == Answers::Defaults {
        return Ok(());
    }
    let subscriptions = ProviderId::ALL
        .into_iter()
        .filter(|p| p.spec().is_subscription());
    for provider in subscriptions {
        let title = provider.spec().title;
        loop {
            let count = store
                .list()?
                .iter()
                .filter(|a| a.provider == provider)
                .count();
            let question = if count == 0 {
                format!("Sign in to a {title} account?")
            } else {
                format!("Add another {title} account? ({count} so far)")
            };
            if !answers.confirm(&question, count == 0)? {
                break;
            }
            // On a machine without a browser, Codex signs in with a code
            // and Claude by pasting the final URL back.
            let headless = !callback::has_browser();
            let options = LoginOptions {
                device: headless && provider.spec().device_login(),
                no_browser: headless,
                ..LoginOptions::default()
            };
            if let Err(e) = login(store, provider, None, options).await {
                println!("    {} {e:#}", ui::yellow("sign-in failed:"));
            }
        }
    }
    Ok(())
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

async fn background(config: &Config, answers: Answers) -> Result<()> {
    if Daemon::new(config).is_running().await {
        println!("  The proxy is running on {}.", config.base_url());
    }
    let manager = Manager::detect();
    let installed = manager.is_some_and(|m| m.status().installed);
    let exe = background::current_exe()?;
    if let Some(manager) = manager.filter(|_| !installed)
        && answers.confirm("Start slopmax at login?", true)?
    {
        let file = background::install_service(config, manager, &exe).await?;
        println!("    {} {}", ui::green("installed"), ui::dim(file.display()));
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
