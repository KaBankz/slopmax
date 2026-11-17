//! Motion, kept short and quiet: a page sweeps in when it opens, a request
//! types itself into the feed as it arrives, and a dialog resolves out of
//! the page. Every effect works on the glyphs and on dim and bold, never on
//! colors, so the terminal's own palette holds throughout.

use std::time::Instant as Clock;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use tachyonfx::{Effect, EffectManager, EffectTimer, Interpolation, fx};

pub struct Effects {
    page: EffectManager<u8>,
    overlay: EffectManager<u8>,
    /// The dialog last brought in, so it comes in once.
    shown: Option<Rect>,
    last: Clock,
    elapsed: tachyonfx::Duration,
}

impl Default for Effects {
    fn default() -> Self {
        Self {
            page: EffectManager::default(),
            overlay: EffectManager::default(),
            shown: None,
            last: Clock::now(),
            elapsed: tachyonfx::Duration::from_millis(0),
        }
    }
}

impl Effects {
    /// Whether anything is moving, so frames come faster than the clock's.
    pub fn running(&self) -> bool {
        self.page.is_running() || self.overlay.is_running()
    }

    /// Marks the start of a frame. A frame after a quiet spell counts as
    /// a short one, so an effect that starts on it is seen from its start.
    pub fn frame(&mut self) {
        let now = Clock::now();
        let elapsed = now
            .saturating_duration_since(self.last)
            .min(std::time::Duration::from_millis(50));
        self.elapsed = elapsed.into();
        self.last = now;
    }

    /// The page sweeps in from the left, its leading edge dim.
    pub fn enter_page(&mut self, area: Rect) {
        self.page.add_unique_effect(0, reveal(320).with_area(area));
    }

    /// Requests that just arrived type themselves in.
    pub fn arrive(&mut self, rows: &[Rect]) {
        for row in rows {
            self.page.add_effect(reveal(450).with_area(*row));
        }
    }

    pub fn process_page(&mut self, buf: &mut Buffer, area: Rect) {
        self.page.process_effects(self.elapsed, buf, area);
    }

    /// A dialog that just opened resolves out of the page.
    pub fn overlay(&mut self, area: Option<Rect>, buf: &mut Buffer) {
        if area != self.shown {
            if let Some(area) = area {
                let timer = EffectTimer::from_ms(180, Interpolation::QuadOut);
                self.overlay
                    .add_unique_effect(0, fx::coalesce(timer).with_area(area));
            }
            self.shown = area;
        }
        if let Some(area) = area {
            self.overlay.process_effects(self.elapsed, buf, area);
        }
    }
}

/// Cells come in from the left: what the edge hasn't reached yet is blank,
/// and a band behind it is dim.
fn reveal(ms: u32) -> Effect {
    let timer = EffectTimer::from_ms(ms, Interpolation::CubicOut);
    fx::effect_fn((), timer, |_, context, cells| {
        let area = context.area;
        let progress = context.alpha();
        let width = f32::from(area.width.max(1));
        let height = f32::from(area.height.max(1));
        // A slight slant, lower rows a little behind.
        let edge = progress * 1.3;
        for (pos, cell) in cells {
            let at = f32::from(pos.x - area.x) / width + f32::from(pos.y - area.y) / height * 0.3;
            if at > edge {
                cell.set_char(' ');
            } else if at > edge - 0.18 {
                cell.set_style(Style::new().add_modifier(Modifier::DIM));
            }
        }
    })
}
