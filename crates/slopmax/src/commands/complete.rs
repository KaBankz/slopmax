//! What a shell's Tab offers beyond the fixed words: the accounts, keys,
//! and settings of this home. Each reads the files on disk, which is
//! quick, and offers nothing when they don't read.

use usage_rs::complete::{Candidate, CompleteCtx};

use super::home;
use slopmax_core::account::Store;
use slopmax_core::config::Config;

/// The accounts, by the numbers and names every `<ACCOUNT>` takes.
pub fn accounts<P>(_: &P, _: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    let Ok(accounts) = Store::of(home()).list() else {
        return Vec::new();
    };
    accounts
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

/// The client keys, by name.
pub fn keys<P>(_: &P, _: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    let Ok(config) = Config::load(home()) else {
        return Vec::new();
    };
    config
        .keys
        .iter()
        .map(|key| Candidate::new(key.name.clone()))
        .collect()
}

/// The settings `slopmax config` changes.
pub fn settings<P>(_: &P, _: &CompleteCtx<'_>) -> Vec<Candidate<'static>> {
    slopmax_client::api::settings::LIVE
        .iter()
        .map(|live| Candidate::described(live.toml, live.summary))
        .chain([Candidate::described(
            "listen",
            "Where the proxy listens (read as it starts)",
        )])
        .collect()
}
