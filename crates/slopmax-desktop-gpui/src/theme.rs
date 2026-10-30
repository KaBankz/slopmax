//! slopmax's look, the same on every system: its own light and dark themes
//! over gpui-kit's components, and IBM Plex Sans, bundled so text sets the
//! same everywhere.
//!
//! The palette is restrained. Neutrals carry the window; a primary action
//! inverts the foreground. Color appears only where it reports a state: a
//! window running short, something failed or wants a look. Providers and
//! chart series tell apart by their names and by shades of neutral.
//! slopmax's pink marks its logo and keyboard focus, nothing else.

use std::borrow::Cow;
use std::sync::Arc;

use gpui_kit::component::{ActiveTheme, Theme, ThemeMode, ThemeRegistry};
use gpui_kit::*;
use slopmax_core::report::Tone;

use crate::prefs::{Appearance, Prefs};

const THEMES: &str = include_str!("../assets/themes/slopmax.json");
const LIGHT: &str = "slopmax Light";
const DARK: &str = "slopmax Dark";
const FONTS: [&[u8]; 3] = [
    include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-Medium.ttf"),
    include_bytes!("../assets/fonts/IBMPlexSans-SemiBold.ttf"),
];

/// Loads the typeface and slopmax's themes, once, before a window opens.
pub(crate) fn init(cx: &mut App) {
    let fonts = FONTS.iter().map(|font| Cow::Borrowed(*font)).collect();
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        eprintln!("slopmax: could not load IBM Plex Sans: {e:#}");
    }
    if let Err(e) = ThemeRegistry::global_mut(cx).load_themes_from_str(THEMES) {
        eprintln!("slopmax: could not load its themes: {e:#}");
        return;
    }
    let themes = ThemeRegistry::global(cx).themes();
    let (light, dark) = (themes.get(LIGHT).cloned(), themes.get(DARK).cloned());
    Theme::update(cx, |theme| {
        if let Some(light) = light {
            theme.light_theme = light;
        }
        if let Some(dark) = dark {
            theme.dark_theme = dark;
        }
    });
}

/// Takes up the appearance the user chose, or else `window`'s.
pub(crate) fn apply(window: &mut Window, cx: &mut App) {
    let system = window.appearance();
    change(system, cx);
}

/// Takes up the appearance the user chose, or else the system's, in every
/// window.
pub(crate) fn refresh(cx: &mut App) {
    let system = cx.window_appearance();
    change(system, cx);
}

fn change(system: WindowAppearance, cx: &mut App) {
    let mode = match cx.global::<Prefs>().appearance {
        Appearance::System => ThemeMode::from(system),
        Appearance::Light => ThemeMode::Light,
        Appearance::Dark => ThemeMode::Dark,
    };
    Theme::change(mode, None, cx);
}

/// Figures all of one width, so numbers that change keep still and
/// columns of them align.
pub(crate) fn tabular() -> FontFeatures {
    FontFeatures(Arc::new(vec![("tnum".into(), 1)]))
}

/// The colors a page draws with, read once a frame.
#[derive(Clone, Copy)]
pub(crate) struct Colors {
    pub(crate) dark: bool,
    /// The page, and the sidebar beside it, a shade apart.
    pub(crate) bg: Hsla,
    pub(crate) sidebar: Hsla,
    /// An inset area: an opened row, a value to copy.
    pub(crate) well: Hsla,
    /// A panel's edge, and the rule between its rows.
    pub(crate) border: Hsla,
    pub(crate) separator: Hsla,
    /// Text: primary, secondary, and faint.
    pub(crate) fg: Hsla,
    pub(crate) muted: Hsla,
    pub(crate) faint: Hsla,
    /// A meter: its empty track, and its fill while it has room.
    pub(crate) track: Hsla,
    pub(crate) meter: Hsla,
    pub(crate) popover: Hsla,
    /// slopmax's pink: its logo and keyboard focus.
    pub(crate) accent: Hsla,
    pub(crate) good: Hsla,
    pub(crate) warn: Hsla,
    pub(crate) bad: Hsla,
    /// A row under the pointer, and a chosen one.
    pub(crate) hover: Hsla,
    pub(crate) selected: Hsla,
}

impl Colors {
    pub(crate) fn of(cx: &App) -> Self {
        let theme = cx.theme();
        let dark = theme.is_dark();
        let pick =
            |light: u32, dark_: u32| -> Hsla { rgba(if dark { dark_ } else { light }).into() };
        Self {
            dark,
            bg: theme.background,
            sidebar: theme.sidebar,
            well: pick(0xf7f7f8ff, 0x212124ff),
            border: theme.border,
            separator: pick(0xefeff1ff, 0x26262aff),
            fg: theme.foreground,
            muted: theme.muted_foreground,
            faint: pick(0xa2a2aaff, 0x6a6a72ff),
            track: pick(0xebebeeff, 0x2c2c31ff),
            meter: pick(0x5a5a62ff, 0xa8a8b0ff),
            popover: theme.popover,
            accent: rgb(0xd63370).into(),
            good: theme.success,
            warn: theme.warning,
            bad: theme.danger,
            hover: pick(0x0000000a, 0xffffff0a),
            selected: pick(0x00000010, 0xffffff12),
        }
    }

    /// A status's color: quiet unless it is a warning or a fault.
    pub(crate) fn tone(&self, tone: Tone) -> Hsla {
        match tone {
            Tone::Good => self.good,
            Tone::Muted | Tone::Accent => self.muted,
            Tone::Warn => self.warn,
            Tone::Bad => self.bad,
        }
    }

    /// A meter's fill: neutral while the window has room, the warning and
    /// fault colors only as it runs short.
    pub(crate) fn fill(&self, tone: Tone) -> Hsla {
        match tone {
            Tone::Warn => self.warn,
            Tone::Bad => self.bad,
            _ => self.meter,
        }
    }

    /// The `i`th part of a stacked column, as for each provider's tokens:
    /// the meter's own tone, then lighter neutrals, so parts tell apart by
    /// shade alone.
    pub(crate) fn stack(&self, i: usize) -> Hsla {
        match i {
            0 => self.meter,
            1 => self.series(2),
            _ => self.series(3),
        }
    }

    /// The `i`th of a chart's neutral series, strongest first.
    pub(crate) fn series(&self, i: usize) -> Hsla {
        let ramp: [u32; 4] = if self.dark {
            [0xe6e6e8, 0x9b9ba3, 0x6a6a72, 0x45454b]
        } else {
            [0x1d1d1f, 0x76767e, 0xa9a9b0, 0xd2d2d7]
        };
        rgb(ramp[i.min(ramp.len() - 1)]).into()
    }
}
