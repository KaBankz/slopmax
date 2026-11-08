//! Account commands: connecting, importing, and managing accounts. While a
//! daemon serves this home, each change goes through its API, as the app's
//! and the dashboard's do, since it is the only writer while it runs; with
//! none, the CLI makes the change on disk itself.

use anyhow::{Context, Result, bail};
use slopmax_client::Client;
use slopmax_client::api::events::{Event, LoginEvent};
use slopmax_client::api::report::{AccountView, RedeemOutcome};
use slopmax_client::api::requests::{
    AccountPatch, AddAccount, ImportOutcome, ImportRequest, ImportSource, RedeemRequest, StartLogin,
};

use super::daemon;
use crate::term;
use crate::ui;
use slopmax_core::account::{self, Store};
use slopmax_core::auth::{self, LoginOptions};
use slopmax_core::config::Config;
use slopmax_core::import::{self, Source};
use slopmax_core::net::Origins;
use slopmax_core::paths::{self, Home};
use slopmax_core::pool::State;
use slopmax_core::provider::credits::Outcome;
use slopmax_core::provider::{Billing, Credential, ProviderId};
use slopmax_core::time::Timestamp;
use slopmax_core::{api, fsx, human};

pub(super) async fn login(
    config: &Config,
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
    let (name, id, plan, created, endpoint) = match daemon(config).await {
        Some(client) => {
            let (account, created) = login_through(&client, provider, label, options).await?;
            let endpoint = (!account.models.is_empty()).then(|| account.models.clone());
            (account.name, account.id, account.plan, created, endpoint)
        }
        None => {
            let (account, created) =
                auth::connect(store, provider, label, options, term::sign_in()).await?;
            let endpoint = account.endpoint.as_ref().map(|e| e.models.clone());
            (account.name(), account.id, account.plan, created, endpoint)
        }
    };
    let plan = plan
        .as_deref()
        .map(|p| format!(" ({p})"))
        .unwrap_or_default();
    println!(
        "{} {provider} account {}{plan} as {}",
        if created { "Connected" } else { "Updated" },
        ui::bold(name),
        ui::dim(&id)
    );
    if !created {
        return Ok(());
    }
    let note = match spec.billing {
        Billing::Subscription => "Check limits with `slopmax status --refresh`.".to_owned(),
        Billing::Metered { backs } => {
            let models = match &endpoint {
                Some(models) if provider == ProviderId::Compat => models.join(", "),
                _ => spec.models.join(", "),
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

/// Connects an account through the daemon: a key or an endpoint at once, a
/// subscription by following the sign-in's progress on the event stream,
/// with addresses pasted at the terminal handed over and Ctrl-C cancelling
/// it.
async fn login_through(
    client: &Client,
    provider: ProviderId,
    label: Option<String>,
    options: LoginOptions,
) -> Result<(AccountView, bool)> {
    if !provider.spec().is_subscription() {
        let asked = match options.endpoint {
            Some(endpoint) => AddAccount::Endpoint {
                url: endpoint.base_url,
                dialect: api::dialect(endpoint.dialect),
                models: endpoint.models,
                key: options.key.filter(|k| !k.is_empty()),
                label,
            },
            None => AddAccount::Key {
                provider: api::provider(provider),
                key: options.key.unwrap_or_default(),
                label,
            },
        };
        let added = client.add_account(&asked).await?;
        return Ok((added.account, true));
    }
    // Following first, so no progress is missed.
    let mut events = client.events().await?;
    let started = client
        .start_login(&StartLogin {
            provider: api::provider(provider),
            device: options.device,
            label,
            no_browser: options.no_browser,
        })
        .await?;
    let mut pasted = term::pasted();
    let title = provider.spec().title;
    loop {
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(Event::Login { id, event })) if id == started.id => match event {
                    LoginEvent::Authorize { url, opened, port, .. } => {
                        term::authorize(title, &url, opened, port);
                    }
                    LoginEvent::DeviceCode { url, code } => term::device_code(&url, &code),
                    LoginEvent::Note { text } => eprintln!("  {text}"),
                    LoginEvent::Done { account, is_new } => return Ok((*account, is_new)),
                    LoginEvent::Failed { message } => bail!("{message}"),
                },
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e).context("following the sign-in"),
                None => bail!("slopmax stopped during the sign-in"),
            },
            Some(address) = pasted.recv() => {
                client.paste_login(&started.id, address.trim()).await?;
            }
            _ = tokio::signal::ctrl_c() => {
                let _ = client.cancel_login(&started.id).await;
                bail!("the sign-in was cancelled");
            }
        }
    }
}

pub(super) async fn import(
    config: &Config,
    store: &Store,
    source: Source,
    own: bool,
) -> Result<()> {
    let (mut imported, mut linked) = (0, 0);
    let mut saved = |provider: &str, name: &str, origin: &str, created: bool, follows: bool| {
        imported += 1;
        linked += usize::from(follows);
        println!(
            "  {} {provider} {} {}",
            if created {
                ui::green("+")
            } else {
                ui::yellow("~")
            },
            ui::bold(name),
            ui::dim(format!("from {origin}"))
        );
    };
    let skipped = |origin: &str, why: &str| println!("  {} {origin}: {why}", ui::dim("skipped"));
    if let Some(client) = daemon(config).await {
        let sources = match source {
            Source::All => None,
            Source::ClaudeCode => Some(vec![ImportSource::ClaudeCode]),
            Source::Codex => Some(vec![ImportSource::Codex]),
            Source::Cliproxyapi => Some(vec![ImportSource::CliProxyApi]),
        };
        let result = client.import(&ImportRequest { sources, own }).await?;
        if result.outcomes.is_empty() {
            println!("No logins found to import.");
            return Ok(());
        }
        for outcome in &result.outcomes {
            match outcome {
                ImportOutcome::Saved {
                    origin,
                    account,
                    is_new,
                    ..
                } => saved(
                    account.provider.as_str(),
                    &account.name,
                    origin,
                    *is_new,
                    account.follows.is_some(),
                ),
                ImportOutcome::Failed {
                    origin, message, ..
                } => skipped(origin, message),
            }
        }
    } else {
        let http = auth::http_client(Origins::default());
        let found = import::discover(&http, source).await;
        if found.is_empty() {
            println!("No logins found to import.");
            return Ok(());
        }
        for result in import::save(store, found, own) {
            match result.account {
                Ok((account, created)) => saved(
                    account.provider.as_str(),
                    &account.name(),
                    &result.origin,
                    created,
                    account.link.is_some(),
                ),
                Err(e) => skipped(&result.origin, &format!("{e:#}")),
            }
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
pub(super) async fn own(config: &Config, store: &Store, query: &str) -> Result<()> {
    let client = daemon(config).await;
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
        match &client {
            Some(client) => drop(client.own(&account.id).await?),
            None => drop(store.update(&account.id, |a| a.link = None)?),
        }
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

pub(super) async fn use_account(config: &Config, store: &Store, query: &str) -> Result<()> {
    let client = daemon(config).await;
    if query == "auto" {
        match &client {
            Some(client) => drop(client.unpin_all().await?),
            None => account::unpin_all(&Home::current())?,
        }
        println!("slopmax will choose accounts automatically.");
        return Ok(());
    }
    let account = store.find(query)?;
    match &client {
        Some(client) => drop(client.pin(&account.id).await?),
        None => account::pin(&Home::current(), &account)?,
    }
    println!(
        "New {} sessions will use {} while it has quota.",
        account.provider,
        ui::bold(account.name())
    );
    Ok(())
}

/// Changes an account through the daemon, or on disk while none runs, and
/// gives its name after.
async fn change(
    config: &Config,
    store: &Store,
    query: &str,
    patch: AccountPatch,
    edit: impl FnOnce(&mut slopmax_core::account::Account),
) -> Result<String> {
    let id = store.find(query)?.id;
    match daemon(config).await {
        Some(client) => {
            let report = client.update_account(&id, &patch).await?;
            let account = report.accounts.into_iter().find(|a| a.id == id);
            Ok(account.map_or(id, |a| a.name))
        }
        None => Ok(store.update(&id, edit)?.name()),
    }
}

pub(super) async fn set_disabled(
    config: &Config,
    store: &Store,
    query: &str,
    disabled: bool,
) -> Result<()> {
    let patch = AccountPatch {
        disabled: Some(disabled),
        ..AccountPatch::default()
    };
    let name = change(config, store, query, patch, |a| a.disabled = disabled).await?;
    let verb = if disabled { "Disabled" } else { "Enabled" };
    println!("{verb} {}", ui::bold(name));
    Ok(())
}

pub(super) async fn rename(
    config: &Config,
    store: &Store,
    query: &str,
    label: String,
) -> Result<()> {
    let id = store.find(query)?.id;
    let patch = AccountPatch {
        label: Some(Some(label.clone())),
        ..AccountPatch::default()
    };
    let name = change(config, store, &id, patch, |a| a.label = Some(label)).await?;
    println!("Renamed {id} to {}", ui::bold(name));
    Ok(())
}

pub(super) async fn set_priority(
    config: &Config,
    store: &Store,
    query: &str,
    priority: i32,
) -> Result<()> {
    let patch = AccountPatch {
        priority: Some(priority),
        ..AccountPatch::default()
    };
    let name = change(config, store, query, patch, |a| a.priority = priority).await?;
    println!("{} now has priority {priority}", ui::bold(name));
    Ok(())
}

pub(super) async fn remove(config: &Config, store: &Store, query: &str) -> Result<()> {
    let account = store.find(query)?;
    match daemon(config).await {
        Some(client) => drop(client.remove_account(&account.id).await?),
        None => account::forget(store, &Home::current(), &account)?,
    }
    println!("Removed {}", ui::bold(account.name()));
    Ok(())
}

pub(super) async fn redeem(config: &Config, store: &Store, query: &str, yes: bool) -> Result<()> {
    let account = store.find(query)?;
    let Some(credits) = account.provider.get().credits() else {
        bail!(
            "{} is a {} account, which has no limit resets",
            account.name(),
            account.provider.spec().title
        );
    };
    if let Some(client) = daemon(config).await {
        return redeem_through(&client, &account.id, yes).await;
    }
    let http = auth::http_client(Origins::default());
    let account = if config.refresh_tokens {
        auth::ensure_fresh(&http, store, &account, false).await?
    } else {
        account
    };
    // As the proxy last saw the provider's own client, which some answer
    // alone.
    let state: State = fsx::read_toml(&paths::state_file())?.unwrap_or_default();
    let agent = state.agents.get(&account.provider).map(String::as_str);
    let available = credits.list(&http, &account, agent).await?;
    let Some(next) = available.first() else {
        println!("{} has no limit resets.", ui::bold(account.name()));
        return Ok(());
    };
    let now = Timestamp::now();
    let expiry = next
        .expires_at
        .map(|at| format!("; the next expires in {}", human::until(at, now)))
        .unwrap_or_default();
    let s = if available.len() == 1 { "" } else { "s" };
    println!(
        "{} has {} limit reset{s}{expiry}.",
        ui::bold(account.name()),
        available.len()
    );
    if !yes && !term::confirm("Reset its usage windows now?", false)? {
        return Ok(());
    }
    match credits
        .redeem(&http, &account, agent, Some(&next.id))
        .await?
    {
        Outcome::Reset => println!("Reset the usage windows on {}.", ui::bold(account.name())),
        Outcome::NothingToReset => println!("Nothing to reset yet; the limit reset was kept."),
        Outcome::NoCredit => println!("No limit reset was available."),
        Outcome::AlreadyRedeemed => println!("That limit reset was already used."),
        Outcome::Declined => println!(
            "{} would not use one right now, so it was kept.",
            account.provider.spec().title
        ),
    }
    Ok(())
}

/// Redeems the soonest of an account's limit resets through the daemon,
/// which holds the account's readings and so knows at once.
async fn redeem_through(client: &Client, id: &str, yes: bool) -> Result<()> {
    let report = client.status().await?;
    let account = report
        .accounts
        .iter()
        .find(|a| a.id == id)
        .with_context(|| format!("slopmax does not hold account {id}"))?;
    let now = Timestamp::now();
    let resets: Vec<_> = account.unexpired_resets(now).collect();
    let Some(next) = resets.first() else {
        println!("{} has no limit resets.", ui::bold(&account.name));
        return Ok(());
    };
    let expiry = next
        .expires_at
        .map(|at| format!("; the next expires in {}", human::until(at, now)))
        .unwrap_or_default();
    let s = if resets.len() == 1 { "" } else { "s" };
    println!(
        "{} has {} limit reset{s}{expiry}.",
        ui::bold(&account.name),
        resets.len()
    );
    if !yes && !term::confirm("Reset its usage windows now?", false)? {
        return Ok(());
    }
    let asked = RedeemRequest {
        reset: Some(next.id.clone()),
    };
    let name = account.name.clone();
    match client.redeem(id, &asked).await?.outcome {
        RedeemOutcome::Reset => println!("Reset the usage windows on {}.", ui::bold(name)),
        RedeemOutcome::NothingToReset => {
            println!("Nothing to reset yet; the limit reset was kept.")
        }
        RedeemOutcome::NoCredit => println!("No limit reset was available."),
        RedeemOutcome::AlreadyRedeemed => println!("That limit reset was already used."),
        RedeemOutcome::Declined => println!(
            "{} would not use one right now, so it was kept.",
            account.provider.title()
        ),
    }
    Ok(())
}
