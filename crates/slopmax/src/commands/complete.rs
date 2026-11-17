//! What a shell's Tab offers beyond the fixed words: the accounts, keys,
//! and settings of this home. Each reads the files on disk, which is
//! quick, and offers nothing when they don't read. A machine that uses a
//! hub has none of the hub's accounts or keys on disk, so it is offered
//! none rather than its own stale ones.

use usage_rs::complete::{Candidate, CompleteCtx};

use super::home;
use crate::cli::ConfigCmd;
use slopmax_client::api::settings::{LIVE, LiveKind};
use slopmax_core::account::Store;
use slopmax_core::config::Config;

/// This home's config, unless there is none yet (reading it would write
/// one: a Tab writes nothing), it reads badly, or it uses a hub.
fn own_config() -> Option<Config> {
    if !home().config().is_file() {
        return None;
    }
    Config::load(home()).ok().filter(|c| c.hub.is_none())
}

/// The accounts, by the numbers and names every `<ACCOUNT>` takes.
pub fn accounts<P>(_: &P, _: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    own_config()
        .and_then(|_| Store::of(home()).list().ok())
        .unwrap_or_default()
        .iter()
        .enumerate()
        .flat_map(|(i, account)| {
            let title = account.provider.spec().title;
            let number = (i + 1).to_string();
            let named = format!("#{number}, {title}");
            let mut words = vec![Candidate::described(
                number,
                format!("{} ({title})", account.name()),
            )];
            for name in [&account.label, &account.email].into_iter().flatten() {
                words.push(Candidate::described(name.clone(), named.clone()));
            }
            words
        })
        .collect()
}

/// `account adopt`'s: the accounts, or all of them.
pub fn adoptable<P>(partial: &P, ctx: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    let mut words = vec![Candidate::described(
        "all",
        "Every login slopmax follows from another tool",
    )];
    words.extend(accounts(partial, ctx));
    words
}

/// The client keys, by name.
pub fn keys<P>(_: &P, _: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    own_config()
        .map(|config| {
            config
                .keys
                .iter()
                .map(|key| Candidate::new(key.name.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// The settings `slopmax config` shows and changes.
pub fn settings<P>(_: &P, _: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    LIVE.iter()
        .map(|live| Candidate::described(live.toml, live.summary))
        .chain([Candidate::described(
            "listen",
            "Where the proxy listens (read as it starts)",
        )])
        .collect()
}

/// The values the setting already typed takes, where they are few.
pub fn setting_values(
    partial: &<ConfigCmd as usage_rs::spec::CommandArgs>::Partial,
    _: &CompleteCtx<'_>,
) -> Vec<Candidate<'static>> {
    let Some(name) = partial.name.as_deref() else {
        return Vec::new();
    };
    let name = String::from_utf8_lossy(name);
    let Some(live) = slopmax_client::api::settings::live(&name) else {
        return Vec::new();
    };
    match live.kind {
        LiveKind::Switch => vec![Candidate::new("on"), Candidate::new("off")],
        LiveKind::Choice => ["reset-first", "fill-first", "least-used", "round-robin"]
            .into_iter()
            .map(Candidate::new)
            .collect(),
        LiveKind::Minutes => Vec::new(),
    }
}
