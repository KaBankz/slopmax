//! `state.toml`: what the daemon keeps between runs. Each account's health
//! and readings, the sessions bound to them, the pins `slopmax use` sets,
//! the nudges already told, and what was last seen of Codex.
//!
//! While a daemon serves a home, it is the only writer: the CLI and the
//! apps change state through its API. With none serving, [`change`] edits
//! the file under the same serve lock, so a daemon starting meanwhile
//! waits for it rather than reading half of it.

use std::path::Path;

use anyhow::{Context, Result, bail};

use crate::fsx;
use crate::paths::Home;
use crate::pool::{Pins, State};

/// The layout written now: pins, nudges and Codex live in `state.toml`.
/// Before it they had files of their own, which are read once, on the
/// first start that finds an older layout, and left in place for a
/// downgrade.
pub const FORMAT: u32 = 2;

/// The state as the file has it, brought up to [`FORMAT`]; empty when there
/// is none.
pub fn read(home: &Home) -> Result<State> {
    let state: State = fsx::read_toml(&home.state())?.unwrap_or_default();
    Ok(upgrade(home, state))
}

/// Takes in what an older layout kept beside the state: `pins.toml` and
/// `nudged.toml`, or the JSON before them, and the model Codex used last,
/// from the ledger. Files that cannot be read are skipped, as the daemon
/// would have started without them.
pub fn upgrade(home: &Home, mut state: State) -> State {
    if state.format >= FORMAT {
        return state;
    }
    if state.pins.is_empty() {
        state.pins = read_old::<Pins>(&home.dir().join("pins.toml")).unwrap_or_default();
    }
    if state.told.is_empty() {
        let toml = home.dir().join("nudged.toml");
        state.told = read_old::<Told>(&toml)
            .map(|t| t.told)
            .or_else(|| fsx::read_json(&toml.with_extension("json")).ok().flatten())
            .unwrap_or_default();
    }
    if state.codex.model.is_none() {
        // Was found again at every start, from the last month's ledger.
        let month_ago =
            crate::time::Timestamp::now() - crate::time::SignedDuration::from_hours(24 * 30);
        state.codex.model = crate::ledger::read(&home.usage(), month_ago)
            .into_iter()
            .rev()
            .find(|e| e.provider == crate::provider::ProviderId::Codex)
            .and_then(|e| e.model);
    }
    state.format = FORMAT;
    state
}

/// The nudges told, as `nudged.toml` kept them.
#[derive(serde::Deserialize)]
struct Told {
    #[serde(default)]
    told: Vec<String>,
}

/// An older file, read without the JSON migration [`fsx::read_toml`] does,
/// so a downgrade still finds it.
fn read_old<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok();
    let text = match text {
        Some(text) => text,
        None => {
            let json = std::fs::read(path.with_extension("json")).ok()?;
            return serde_json::from_slice(&json).ok();
        }
    };
    toml_edit::de::from_str(&text).ok()
}

/// Changes the state on disk while no daemon serves `home`: under its serve
/// lock, so neither can write over the other. With a daemon serving, the
/// change belongs to it, through its API.
pub fn change<T>(home: &Home, edit: impl FnOnce(&mut State) -> T) -> Result<T> {
    let _serving = offline(home)?;
    let mut state = read(home)?;
    let out = edit(&mut state);
    fsx::write_toml(&home.state(), &state)
        .with_context(|| format!("saving {}", home.state().display()))?;
    Ok(out)
}

/// The home's serve lock, taken without waiting: a daemon holds it for as
/// long as it serves, and a change made while it does would be lost when
/// it next saves.
pub fn offline(home: &Home) -> Result<std::fs::File> {
    let path = home.dir().join(".serve.lock");
    fsx::private_dir(home.dir())?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => bail!(
            "slopmax is serving {}, so the change goes through it; is it reachable at the \
             address config.toml gives?",
            home.dir().display()
        ),
        Err(std::fs::TryLockError::Error(e)) => {
            Err(e).with_context(|| format!("locking {}", path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderId;

    fn home(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("slopmax-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Home::at(dir)
    }

    #[test]
    fn an_older_layout_is_read_once_and_left_in_place() {
        let home = home("upgrade");
        std::fs::write(home.dir().join("pins.toml"), "claude = \"acct-1\"\n").unwrap();
        std::fs::write(home.dir().join("nudged.json"), r#"["a:b:1"]"#).unwrap();

        let state = read(&home).unwrap();
        assert_eq!(state.pins.get(&ProviderId::Claude).unwrap(), "acct-1");
        assert_eq!(state.told, ["a:b:1"]);
        assert_eq!(state.format, FORMAT);
        // Left for a downgrade.
        assert!(home.dir().join("pins.toml").exists());
        assert!(home.dir().join("nudged.json").exists());

        // Once written, the state is what counts: unpinning sticks.
        change(&home, |s| s.pins.clear()).unwrap();
        assert!(read(&home).unwrap().pins.is_empty());
        std::fs::remove_dir_all(home.dir()).unwrap();
    }

    #[test]
    fn a_serving_daemon_keeps_the_file_to_itself() {
        let home = home("serving");
        let held = offline(&home).unwrap();
        let error = change(&home, |s| s.pins.clear()).unwrap_err();
        assert!(error.to_string().contains("goes through it"), "{error}");
        drop(held);
        change(&home, |s| s.pins.clear()).unwrap();
        std::fs::remove_dir_all(home.dir()).unwrap();
    }
}
