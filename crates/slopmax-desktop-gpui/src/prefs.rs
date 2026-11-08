//! The window's settings as the user leaves them: the sidebar's width and
//! whether it hides, and the appearance chosen. They live in slopmax's
//! home, beside its other state, so they hold on every system.

use std::path::PathBuf;

use gpui_kit::Global;
use serde::{Deserialize, Serialize};

use crate::SIDEBAR;

/// Light or dark, or as the system has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    pub(crate) const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::System => "System",
            Self::Light => "Light",
            Self::Dark => "Dark",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Prefs {
    pub(crate) sidebar_width: f32,
    pub(crate) sidebar_hidden: bool,
    pub(crate) appearance: Appearance,
}

impl Global for Prefs {}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            sidebar_width: SIDEBAR,
            sidebar_hidden: false,
            appearance: Appearance::System,
        }
    }
}

fn path() -> PathBuf {
    slopmax_app::home().join("desktop.json")
}

impl Prefs {
    /// The settings last saved, or the defaults.
    pub(crate) fn load() -> Self {
        std::fs::read(path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Saves the settings; a failure only loses them for next time.
    pub(crate) fn save(&self) {
        let path = path();
        let saved = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, serde_json::to_vec_pretty(self)?));
        if let Err(e) = saved {
            eprintln!("slopmax: could not save {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Appearance, Prefs};

    #[test]
    fn missing_settings_take_their_defaults() {
        let prefs: Prefs = serde_json::from_str(r#"{"appearance": "dark"}"#).unwrap();
        assert_eq!(prefs.appearance, Appearance::Dark);
        assert_eq!(prefs.sidebar_width, Prefs::default().sidebar_width);
        assert!(!prefs.sidebar_hidden);
    }
}
