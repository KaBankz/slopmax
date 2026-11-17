//! Colors, drawn from the user's own terminal palette.
//!
//! Text is drawn in the terminal's default colors and its 16 named ANSI
//! colors, with bold, dim and italic for hierarchy, so whatever theme the
//! terminal has shows through. The one thing read from the terminal is its
//! background, asked once before the screen is taken over: where the
//! terminal draws in true color, the sidebar, the selected row and dialogs
//! sit on surfaces a few shades off it. Where the background can't be read
//! (tmux often won't say), surfaces stay the terminal's own background.
//! `NO_COLOR` leaves only bold, dim and underline.

use std::time::Duration;

use ratatui::style::{Color, Modifier, Style};
use slopmax_client::api::Tone;

#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    /// Off under `NO_COLOR`.
    pub color: bool,
    /// A shade off the background: the sidebar and panels.
    pub surface: Option<Color>,
    /// Further off: the selected row, dialogs and toasts.
    pub raised: Option<Color>,
    /// The terminal's background is light.
    pub light: bool,
}

impl Theme {
    /// The terminal's theme, asked of the terminal; called before raw mode,
    /// as the question and its answer go through the terminal.
    pub fn detect() -> Self {
        let color = std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty());
        let truecolor = std::env::var("COLORTERM")
            .is_ok_and(|v| v.eq_ignore_ascii_case("truecolor") || v.eq_ignore_ascii_case("24bit"));
        let mut options = terminal_colorsaurus::QueryOptions::default();
        options.timeout = Duration::from_millis(100);
        let palette = terminal_colorsaurus::color_palette(options).ok();
        let light = palette
            .as_ref()
            .is_some_and(|p| p.theme_mode() == terminal_colorsaurus::ThemeMode::Light);
        let (surface, raised) = match (&palette, truecolor && color) {
            (Some(p), true) => {
                let bg = p.background.scale_to_8bit();
                let fg = p.foreground.scale_to_8bit();
                (Some(mix(bg, fg, 0.045)), Some(mix(bg, fg, 0.11)))
            }
            _ => (None, None),
        };
        Self {
            color,
            surface,
            raised,
            light,
        }
    }

    /// The terminal's default colors and no surfaces, as the tests draw.
    #[cfg(test)]
    pub fn plain() -> Self {
        Self {
            color: true,
            surface: None,
            raised: None,
            light: false,
        }
    }

    fn fg(&self, color: Color) -> Style {
        if self.color {
            Style::new().fg(color)
        } else {
            Style::new()
        }
    }

    /// How a tone from the API is drawn.
    pub fn tone(&self, tone: Tone) -> Style {
        if !self.color {
            return match tone {
                Tone::Good => Style::new(),
                Tone::Muted => self.muted(),
                Tone::Accent | Tone::Warn => Style::new().add_modifier(Modifier::BOLD),
                Tone::Bad => Style::new().add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            };
        }
        match tone {
            Tone::Good => self.fg(Color::Green),
            Tone::Muted => self.muted(),
            Tone::Accent => self.accent(),
            Tone::Warn => self.fg(Color::Yellow),
            Tone::Bad => self.fg(Color::Red),
        }
    }

    /// Secondary text: labels, units, hints.
    pub fn muted(&self) -> Style {
        Style::new().add_modifier(Modifier::DIM)
    }

    /// slopmax's one color: the page you're on, what is selected, links.
    pub fn accent(&self) -> Style {
        self.fg(Color::Cyan)
    }

    pub fn strong(&self) -> Style {
        Style::new().add_modifier(Modifier::BOLD)
    }

    /// Rules and borders.
    pub fn rule(&self) -> Style {
        Style::new().add_modifier(Modifier::DIM)
    }

    /// The part of a bar not yet used.
    pub fn track(&self) -> Style {
        Style::new().add_modifier(Modifier::DIM)
    }

    /// The sidebar's and panels' background, when there is one.
    pub fn surface(&self) -> Style {
        match self.surface {
            Some(bg) => Style::new().bg(bg),
            None => Style::new(),
        }
    }

    /// The selected row's, dialogs' and toasts' background.
    pub fn raised(&self) -> Style {
        match self.raised {
            Some(bg) => Style::new().bg(bg),
            None => Style::new(),
        }
    }

    /// A chart's marks: the foreground itself, as the dashboard draws its
    /// charts in its text color.
    pub fn ink(&self) -> Style {
        Style::new()
    }
}

/// `a` moved `by` (0 to 1) of the way to `b`.
fn mix(a: (u8, u8, u8), b: (u8, u8, u8), by: f32) -> Color {
    let channel = |a: u8, b: u8| (f32::from(a) + (f32::from(b) - f32::from(a)) * by).round() as u8;
    Color::Rgb(channel(a.0, b.0), channel(a.1, b.1), channel(a.2, b.2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_are_a_few_shades_off_the_background() {
        assert_eq!(mix((0, 0, 0), (255, 255, 255), 0.1), Color::Rgb(26, 26, 26));
        assert_eq!(
            mix((250, 250, 250), (20, 20, 20), 0.05),
            Color::Rgb(239, 239, 239)
        );
    }

    #[test]
    fn without_color_tones_are_told_apart_by_weight() {
        let theme = Theme {
            color: false,
            ..Theme::plain()
        };
        assert_eq!(theme.tone(Tone::Good), Style::new());
        assert!(
            theme
                .tone(Tone::Bad)
                .add_modifier
                .contains(Modifier::UNDERLINED)
        );
        assert_eq!(theme.accent(), Style::new());
    }
}
