//! Account commands: status, login, import, and managing accounts.

use std::collections::HashMap;
use std::io::Write as _;
use std::time::Duration;

use anyhow::{Result, bail};

use super::background::Daemon;
use super::{StatusArgs, term};
use crate::account::Store;
use crate::auth::{self, LoginOptions};
use crate::config::Config;
use crate::import::{self, Source};
use crate::net::Origins;
use crate::pool::{Pins, Pool, State};
use crate::provider::credits::Outcome;
use crate::provider::{Billing, Credential, ProviderId};
use crate::report::{self, Report};
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, human, paths, ui, usage};

pub(super) async fn status(config: &Config, store: &Store, args: StatusArgs) -> Result<()> {
    let daemon = Daemon::new(config);
    let mut refresh = args.refresh;
    loop {
        let report = match daemon.report(refresh).await {
            Some(report) => report,
            None => offline_report(config, store, refresh).await?,
        };
        if args.json {
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }
        let text = report::render(&report, Timestamp::now());
        if args.watch {
            print!("\x1b[2J\x1b[H{text}");
            std::io::stdout().flush()?;
        } else {
            print!("{text}");
            return Ok(());
        }
        refresh = false;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Status from disk when no proxy is running, optionally polling the
/// providers directly.
async fn offline_report(config: &Config, store: &Store, refresh: bool) -> Result<Report> {
    let state: State = fsx::read_json(&paths::state_file())?.unwrap_or_default();
    let pins: Pins = fsx::read_json(&paths::pins_file())?.unwrap_or_default();
    let pool = Pool::new(config.strategy, SignedDuration::from_hours(1), state);
    pool.sync(store.list()?, pins.clone());
    if refresh {
        let http = auth::http_client(Origins::default());
        let polled = pool
            .accounts()
            .into_iter()
            .filter(|a| a.auth_error.is_none() && a.provider.spec().is_subscription());
        for account in polled {
            match usage::poll(&http, store, &account, config.refresh_tokens).await {
                Ok((_, reading)) => pool.observe(&account.id, reading.limits, Timestamp::now()),
                Err(e) => eprintln!("{} {}: {e:#}", ui::yellow("warning:"), account.name()),
            }
        }
        let (state, _) = pool.snapshot(Timestamp::now());
        fsx::write_json(&paths::state_file(), &state)?;
    }
    Ok(report::build(
        store.list()?,
        |id| pool.state(id),
        &pins,
        &HashMap::new(),
        config.strategy,
        false,
        Timestamp::now(),
    ))
}

pub(super) async fn login(
    store: &Store,
    provider: ProviderId,
    label: Option<String>,
    mut options: LoginOptions,
) -> Result<()> {
    let spec = provider.spec();
    if options.device && !spec.device_login() {
        bail!(
            "--device works for ChatGPT accounts; {} signs in with a browser",
            spec.title
        );
    }
    if let Credential::Key { optional } = spec.credential {
        let prompt = if optional {
            "API key (leave empty if it needs none)".to_owned()
        } else {
            format!("{} key", spec.title)
        };
        options.key = Some(term::read_secret(&prompt)?);
    }
    let (account, created) =
        auth::connect(store, provider, label, options, term::sign_in()).await?;
    let plan = account
        .plan
        .as_deref()
        .map(|p| format!(" ({p})"))
        .unwrap_or_default();
    println!(
        "{} {provider} account {}{plan} as {}",
        if created { "Connected" } else { "Updated" },
        ui::bold(account.name()),
        ui::dim(&account.id)
    );
    if !created {
        return Ok(());
    }
    let note = match spec.billing {
        Billing::Subscription => "Check limits with `slopmax status --refresh`.".to_owned(),
        Billing::Metered { backs } => {
            let models = match &account.endpoint {
                Some(endpoint) => endpoint.models.join(", "),
                None => spec.models.join(", "),
            };
            let backed = backs.filter(|sub| {
                store
                    .list()
                    .is_ok_and(|all| all.iter().any(|a| a.provider == *sub))
            });
            match backed {
                Some(sub) => format!(
                    "It serves {models} when asked for by name ({provider}/<model>), or once \
                     every {} account is limited if `paid_overflow = true` in config.toml.",
                    sub.spec().title
                ),
                None => format!("It serves {models}."),
            }
        }
    };
    println!("{}", ui::dim(note));
    Ok(())
}

pub(super) async fn import(store: &Store, source: Source, own: bool) -> Result<()> {
    let http = auth::http_client(Origins::default());
    let found = import::discover(&http, source).await;
    if found.is_empty() {
        println!("No logins found to import.");
        return Ok(());
    }
    let (mut imported, mut linked) = (0, 0);
    for item in found {
        match item.account {
            Ok(mut account) => {
                if own {
                    account.link = None;
                }
                let (account, created) = store.upsert(account)?;
                imported += 1;
                linked += usize::from(account.link.is_some());
                println!(
                    "  {} {} {} {}",
                    if created {
                        ui::green("+")
                    } else {
                        ui::yellow("~")
                    },
                    account.provider,
                    ui::bold(account.name()),
                    ui::dim(format!("from {}", item.origin))
                );
            }
            Err(e) => println!("  {} {}: {e:#}", ui::dim("skipped"), item.origin),
        }
    }
    if linked > 0 {
        println!(
            "\n{} CLIProxyAPI keeps refreshing {linked} of these, and slopmax follows its files,\n        \
             so both can run while you switch over. Once CLIProxyAPI is stopped, run\n        \
             `slopmax own all` so slopmax refreshes them.",
            ui::cyan("linked:")
        );
    }
    if imported > linked {
        println!(
            "\n{} Imported logins share refresh tokens with their source, and whichever\n      \
             refreshes first invalidates the other's copy. Use the agents through slopmax\n      \
             from now on (`slopmax setup claude`, `slopmax setup codex`).",
            ui::yellow("note:")
        );
    }
    Ok(())
}

/// Stops following another tool's copy of an account's tokens.
pub(super) fn own(store: &Store, query: &str) -> Result<()> {
    let accounts = if query == "all" {
        store
            .list()?
            .into_iter()
            .filter(|a| a.link.is_some())
            .collect()
    } else {
        vec![store.find(query)?]
    };
    if accounts.is_empty() {
        println!("No accounts follow another tool.");
        return Ok(());
    }
    for account in accounts {
        let Some(link) = &account.link else {
            println!("{} already refreshes here.", ui::bold(account.name()));
            continue;
        };
        store.update(&account.id, |a| a.link = None)?;
        println!(
            "slopmax now refreshes {} {}",
            ui::bold(account.name()),
            ui::dim(format!("(was following {})", link.tool))
        );
    }
    println!(
        "{}",
        ui::dim("Its first refresh signs the old copy out, so keep the other tool stopped.")
    );
    Ok(())
}

pub(super) fn use_account(store: &Store, query: &str) -> Result<()> {
    let path = paths::pins_file();
    let mut pins: Pins = fsx::read_json(&path)?.unwrap_or_default();
    if query == "auto" {
        pins.clear();
        fsx::write_json(&path, &pins)?;
        println!("slopmax will choose accounts automatically.");
        return Ok(());
    }
    let account = store.find(query)?;
    pins.insert(account.provider, account.id.clone());
    fsx::write_json(&path, &pins)?;
    println!(
        "New {} sessions will use {} while it has quota.",
        account.provider,
        ui::bold(account.name())
    );
    Ok(())
}

pub(super) fn set_disabled(store: &Store, query: &str, disabled: bool) -> Result<()> {
    let id = store.find(query)?.id;
    let account = store.update(&id, |a| a.disabled = disabled)?;
    let verb = if disabled { "Disabled" } else { "Enabled" };
    println!("{verb} {}", ui::bold(account.name()));
    Ok(())
}

pub(super) fn remove(store: &Store, query: &str) -> Result<()> {
    let account = store.find(query)?;
    store.remove(&account.id)?;
    let path = paths::pins_file();
    let mut pins: Pins = fsx::read_json(&path)?.unwrap_or_default();
    if pins.get(&account.provider) == Some(&account.id) {
        pins.remove(&account.provider);
        fsx::write_json(&path, &pins)?;
    }
    println!("Removed {}", ui::bold(account.name()));
    Ok(())
}

pub(super) async fn redeem(config: &Config, store: &Store, query: &str, yes: bool) -> Result<()> {
    let account = store.find(query)?;
    let Some(credits) = account.provider.get().credits() else {
        bail!(
            "{} is a {} account, which has no reset credits",
            account.name(),
            account.provider.spec().title
        );
    };
    let http = auth::http_client(Origins::default());
    let account = if config.refresh_tokens {
        auth::ensure_fresh(&http, store, &account, false).await?
    } else {
        account
    };
    let available = credits.list(&http, &account).await?;
    let Some(next) = available.first() else {
        println!("{} has no reset credits.", ui::bold(account.name()));
        return Ok(());
    };
    let now = Timestamp::now();
    let expiry = next
        .expires_at
        .map(|at| format!("; the next expires in {}", human::until(at, now)))
        .unwrap_or_default();
    let s = if available.len() == 1 { "" } else { "s" };
    println!(
        "{} has {} reset credit{s}{expiry}.",
        ui::bold(account.name()),
        available.len()
    );
    if !yes && !term::confirm("Reset its usage windows now?", false)? {
        return Ok(());
    }
    match credits.redeem(&http, &account, Some(&next.id)).await? {
        Outcome::Reset => {
            println!("Reset the usage windows on {}.", ui::bold(account.name()));
            // Let a running proxy pick up the fresh windows right away.
            Daemon::new(config).report(true).await;
        }
        Outcome::NothingToReset => println!("Nothing to reset right now; the credit was kept."),
        Outcome::NoCredit => println!("No credit was available."),
        Outcome::AlreadyRedeemed => println!("That credit was already redeemed."),
    }
    Ok(())
}
