//! How things move, and how little. Motion shows what changed in answer to
//! a press, and nothing else: no page loads into a sequence, nothing pulses
//! or bounces, and what happens many times a day, or from the keyboard,
//! happens at once. GPUI skips every animation when the system asks for
//! reduced motion.
//!
//! The curves are cubic Béziers, stronger than the stock eases, after Emil
//! Kowalski's design engineering standards: an ease-out for what appears,
//! so it answers at once, and an ease-in-out for what moves across the
//! screen.

use std::time::Duration;

/// What appears or opens: a notice, a row's details.
pub(crate) const APPEAR: Duration = Duration::from_millis(200);
/// What slides across the window: the sidebar.
pub(crate) const SLIDE: Duration = Duration::from_millis(220);

/// cubic-bezier(0.23, 1, 0.32, 1).
pub(crate) fn ease_out(t: f32) -> f32 {
    bezier(0.23, 1., 0.32, 1., t)
}

/// cubic-bezier(0.77, 0, 0.175, 1).
pub(crate) fn ease_in_out(t: f32) -> f32 {
    bezier(0.77, 0., 0.175, 1., t)
}

/// The curve through (0, 0), (`x1`, `y1`), (`x2`, `y2`) and (1, 1), read
/// at `x`: its parameter found by bisection, as `x` rises with it.
fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    let x = x.clamp(0., 1.);
    let at = |p1: f32, p2: f32, s: f32| {
        let r = 1. - s;
        3. * r * r * s * p1 + 3. * r * s * s * p2 + s * s * s
    };
    let (mut low, mut high) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (low + high) / 2.;
        if at(x1, x2, mid) < x {
            low = mid;
        } else {
            high = mid;
        }
    }
    at(y1, y2, (low + high) / 2.)
}

#[cfg(test)]
mod tests {
    use super::{ease_in_out, ease_out};

    #[test]
    fn curves_run_from_rest_to_rest() {
        for curve in [ease_out, ease_in_out] {
            assert!(curve(0.).abs() < 1e-3);
            assert!((curve(1.) - 1.).abs() < 1e-3);
            let mut last = 0.;
            for i in 1..=50 {
                let y = curve(i as f32 / 50.);
                assert!(y >= last - 1e-4, "a curve never turns back");
                last = y;
            }
        }
    }

    #[test]
    fn the_ease_out_answers_at_once() {
        // Most of the way there by a quarter of the time.
        assert!(ease_out(0.25) > 0.7);
    }

    #[test]
    fn the_ease_in_out_holds_back_then_settles() {
        assert!(ease_in_out(0.1) < 0.05);
        // A little past halfway at half time, and all but there by 90%.
        assert!((0.5..0.7).contains(&ease_in_out(0.5)));
        assert!(ease_in_out(0.9) > 0.98);
    }
}
