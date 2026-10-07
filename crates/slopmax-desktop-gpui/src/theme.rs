//! slopmax's look, the same on every system: its own light and dark themes
//! over gpui-kit's components, in slopmax's pink; the Inter typeface,
//! bundled so text sets the same everywhere; and the colors the pages draw
//! with beyond the theme's: surfaces, text in three strengths, each
//! provider's color, and the brand's gradient.

use std::borrow::Cow;
use std::sync::Arc;

use gpui_kit::component::{ActiveTheme, Theme, ThemeMode, ThemeRegistry};
use gpui_kit::*;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;

use crate::prefs::{Appearance, Prefs};

const THEMES: &str = include_str!("../assets/themes/slopmax.json");
const LIGHT: &str = "slopmax Light";
const DARK: &str = "slopmax Dark";
const FONTS: [&[u8]; 5] = [
    include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Inter-Bold.ttf"),
    include_bytes!("../assets/fonts/InterDisplay-SemiBold.ttf"),
];

/// The family large numbers and titles set in: Inter's cut for display
/// sizes, drawn tighter.
pub(crate) const DISPLAY: &str = "Inter Display";

/// Loads the typeface and slopmax's themes, once, before a window opens.
pub(crate) fn init(cx: &mut App) {
    let fonts = FONTS.iter().map(|font| Cow::Borrowed(*font)).collect();
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        eprintln!("slopmax: could not load Inter: {e:#}");
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

/// Inter's figures all of one width, so numbers that change keep still.
pub(crate) fn tabular() -> FontFeatures {
    FontFeatures(Arc::new(vec![("tnum".into(), 1)]))
}

/// The colors a page draws with, read once a frame.
#[derive(Clone, Copy)]
pub(crate) struct Colors {
    pub(crate) dark: bool,
    /// The page behind everything, and the sidebar beside it.
    pub(crate) bg: Hsla,
    pub(crate) sidebar: Hsla,
    /// A card, and a well or a hover within one.
    pub(crate) surface: Hsla,
    pub(crate) well: Hsla,
    /// A card's edge, and a rule within one.
    pub(crate) border: Hsla,
    pub(crate) separator: Hsla,
    /// Text: primary, secondary, and faint.
    pub(crate) fg: Hsla,
    pub(crate) muted: Hsla,
    pub(crate) faint: Hsla,
    /// An empty gauge.
    pub(crate) track: Hsla,
    pub(crate) popover: Hsla,
    /// slopmax's pink, and the violet its gradient runs to.
    pub(crate) accent: Hsla,
    pub(crate) violet: Hsla,
    pub(crate) good: Hsla,
    pub(crate) warn: Hsla,
    pub(crate) bad: Hsla,
    pub(crate) info: Hsla,
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
            surface: pick(0xffffffff, 0x121218ff),
            well: pick(0xf4f4f7ff, 0x18181fff),
            border: pick(0xe7e7edff, 0x1f1f28ff),
            separator: pick(0xeeeef3ff, 0x1c1c24ff),
            fg: theme.foreground,
            muted: theme.muted_foreground,
            faint: pick(0x9a9aa8ff, 0x5c5c6bff),
            track: pick(0xececf1ff, 0x1f1f28ff),
            popover: theme.popover,
            accent: theme.primary,
            violet: pick(0x8b5cf6ff, 0xa78bfaff),
            good: theme.success,
            warn: theme.warning,
            bad: theme.danger,
            info: theme.info,
            hover: pick(0x0000000a, 0xffffff0a),
            selected: pick(0x0000000f, 0xffffff12),
        }
    }

    pub(crate) fn tone(&self, tone: Tone) -> Hsla {
        match tone {
            Tone::Good => self.good,
            Tone::Muted => self.muted,
            Tone::Accent => self.accent,
            Tone::Warn => self.warn,
            Tone::Bad => self.bad,
        }
    }

    /// A gauge's color: its provider's while it has room, and the warning
    /// and bad colors only as it runs short.
    pub(crate) fn gauge(&self, tone: Tone, provider: ProviderId) -> Hsla {
        match tone {
            Tone::Good | Tone::Muted | Tone::Accent => self.provider(provider),
            tone => self.tone(tone),
        }
    }

    /// A provider's color, on every page and chart: its brand's.
    pub(crate) fn provider(&self, provider: ProviderId) -> Hsla {
        let pick =
            |light: u32, dark: u32| -> Hsla { rgb(if self.dark { dark } else { light }).into() };
        match provider {
            ProviderId::Claude | ProviderId::Anthropic => pick(0xd97757, 0xe8875f),
            ProviderId::Codex | ProviderId::OpenAI => pick(0x10a37f, 0x2fc48d),
            ProviderId::Xai => pick(0x52525b, 0xd4d4dc),
            _ => self.violet,
        }
    }

    /// slopmax's gradient, pink to violet, at `angle` degrees.
    pub(crate) fn brand(&self, angle: f32) -> Background {
        linear_gradient(
            angle,
            linear_color_stop(self.accent, 0.),
            linear_color_stop(self.violet, 1.),
        )
    }

    /// `color` washed over the surface, for a chip or an icon's tile.
    pub(crate) fn tint(&self, color: Hsla) -> Hsla {
        color.opacity(if self.dark { 0.16 } else { 0.12 })
    }
}
