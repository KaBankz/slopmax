//! `slopmax agent`: which agents point at slopmax, connecting and
//! disconnecting them, and running one through the proxy.

use anyhow::{Context, Result};

use super::{daemon, ensure_running, home};
use crate::cli::{AgentArg, AgentRun};
use crate::ui;
use slopmax_core::account::Store;
use slopmax_core::agent::{self, Agent};
use slopmax_core::config::Config;

/// The agent `arg` names.
fn agent_of(arg: AgentArg) -> &'static dyn Agent {
    agent::find(arg.word()).expect("every agent the parser takes is registered")
}

/// `slopmax agent list`.
pub(super) fn list(config: &Config, json: bool) -> Result<()> {
    let agents = slopmax_core::api::agents(config, home());
    if json {
        println!("{}", serde_json::to_string_pretty(&agents)?);
        return Ok(());
    }
    let width = agents.iter().map(|a| a.title.len()).max().unwrap_or(0);
    let states: Vec<String> = agents
        .iter()
        .map(|wiring| {
            if wiring.wired {
                ui::green("connected")
            } else if let Some(target) = &wiring.wired_to {
                ui::yellow(format!("points at {target}"))
            } else if wiring.installed {
                "not connected".to_owned()
            } else {
                ui::dim("not installed")
            }
        })
        .collect();
    let state_width = states
        .iter()
        .map(|s| ui::visible_width(s))
        .max()
        .unwrap_or(0);
    for ((agent, wiring), state) in agent::AGENTS.iter().zip(&agents).zip(&states) {
        println!(
            "{}  {:<6}  {}  {}",
            ui::bold(ui::pad(&wiring.title, width)),
            agent.id(),
            ui::pad(state, state_width),
            ui::dim(&wiring.config_path),
        );
    }
    println!(
        "\n{}",
        ui::dim(
            "`slopmax agent connect <agent>` points one at slopmax for good; \
             `slopmax run <agent>` runs one through it once."
        )
    );
    Ok(())
}

/// `slopmax agent connect`: points the agent at slopmax in its own config
/// file, keeping what it replaces for `disconnect`.
pub(super) async fn connect(config: &Config, store: &Store, arg: AgentArg) -> Result<()> {
    let agent = agent_of(arg);
    let app = agent.title();
    let path = agent::setup(agent, config, home())?;
    let undo = format!("Undo with `slopmax agent disconnect {}`.", agent.id());
    if let Some(url) = config.hub_url() {
        println!(
            "{app} now uses the hub at {} {}",
            url.trim_end_matches('/'),
            ui::dim(format!("({})", path.display()))
        );
        println!("{}", ui::dim(agent.setup_note()));
        println!("{}", ui::dim(undo));
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
    let next = if slopmax_core::background::Daemon::new(config)
        .is_running()
        .await
    {
        undo
    } else {
        format!("Start the proxy with `slopmax proxy start` (or `slopmax proxy install`). {undo}")
    };
    println!("{}", ui::dim(next));
    Ok(())
}

/// `slopmax agent disconnect`: puts back what `connect` replaced.
pub(super) fn disconnect(arg: AgentArg) -> Result<()> {
    let agent = agent_of(arg);
    let path = agent::undo(agent, home())?;
    println!(
        "Restored {} {}",
        agent.title(),
        ui::dim(format!("({})", path.display()))
    );
    Ok(())
}

/// `slopmax run` and `slopmax agent run`: the agent, through the proxy,
/// with its exit code.
pub(super) async fn run(config: &Config, run: AgentRun) -> Result<i32> {
    let agent = agent_of(run.agent);
    // Before the proxy starts: it would be left running for nothing.
    agent::installed(agent, config, home())?;
    if config.hub.is_some() {
        // The hub must answer; nothing runs here.
        daemon(config).await?;
    } else {
        ensure_running(config).await?;
    }
    agent::run(agent, config, home(), &run.args)
}

/// `slopmax agent env`: shell setup for `eval`.
pub(super) fn env(config: &Config, arg: AgentArg) -> Result<()> {
    let exe = std::env::current_exe().context("locating the slopmax binary")?;
    print!("{}", agent_of(arg).env(config, home(), &exe));
    Ok(())
}
