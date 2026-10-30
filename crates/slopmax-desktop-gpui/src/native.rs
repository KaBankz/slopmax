//! What GPUI does not reach of AppKit: the menu bar item's template glyph
//! and where the item sits, clicks in other apps, which close the menu bar
//! panel, and the panel's height as it fits its content. Elsewhere each
//! does nothing, and the panel opens as the window would.

#[cfg(target_os = "macos")]
mod mac {
    use gpui_kit::*;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSApplication, NSImage, NSScreen, NSStatusBarButton, NSView, NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::NSString;

    /// The menu bar item's button, in a status bar window of the app's own.
    fn status_button(
        mtm: MainThreadMarker,
    ) -> Option<(Retained<NSWindow>, Retained<NSStatusBarButton>)> {
        fn find(view: Retained<NSView>) -> Option<Retained<NSStatusBarButton>> {
            match view.downcast::<NSStatusBarButton>() {
                Ok(button) => Some(button),
                Err(view) => view.subviews().iter().find_map(find),
            }
        }
        NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .find_map(|window| Some((window.clone(), find(window.contentView()?)?)))
    }

    /// Gives the menu bar item a template glyph, which the menu bar tints
    /// to suit itself: three rising bars, as the app's mark has.
    pub(crate) fn menu_bar_glyph() {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let glyph = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str("chart.bar.fill"),
            Some(&NSString::from_str("slopmax")),
        );
        if let (Some(glyph), Some((_, button))) = (glyph, status_button(mtm)) {
            button.setImage(Some(&glyph));
        }
    }

    pub(crate) fn status_item() -> Option<Bounds<Pixels>> {
        let mtm = MainThreadMarker::new()?;
        let (window, _) = status_button(mtm)?;
        // AppKit counts up from the bottom of the main screen; GPUI down from
        // its top.
        let main = NSScreen::screens(mtm).firstObject()?.frame();
        let top = main.origin.y + main.size.height;
        let frame = window.frame();
        Some(Bounds::new(
            point(
                px(frame.origin.x as f32),
                px((top - frame.origin.y - frame.size.height) as f32),
            ),
            size(px(frame.size.width as f32), px(frame.size.height as f32)),
        ))
    }

    pub(crate) fn outside_clicks() -> Option<async_channel::Receiver<()>> {
        use objc2_app_kit::{NSEvent, NSEventMask};

        let (clicks, heard) = async_channel::unbounded();
        let handler = block2::RcBlock::new(move |_| {
            let _ = clicks.try_send(());
        });
        // Kept for the app's life, as removing a monitor takes unsafe code.
        let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown,
            &handler,
        )?;
        std::mem::forget(monitor);
        Some(heard)
    }

    /// Makes the panel `height` tall, keeping its top under the menu bar,
    /// as GPUI keeps a window's bottom instead, and its shadow to its new
    /// outline.
    pub(crate) fn hang(window: &Window, height: f32) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let width = f64::from(window.bounds().size.width.as_f32());
        // The panel: a popup, which AppKit makes a non-activating panel, of
        // the panel's width.
        let Some(native) = NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .filter(|w| {
                w.styleMask()
                    .contains(NSWindowStyleMask::NonactivatingPanel)
                    && (w.frame().size.width - width).abs() < 1.
            })
            .last()
        else {
            return;
        };
        let mut frame = native.frame();
        let top = frame.origin.y + frame.size.height;
        frame.size.height = f64::from(height);
        frame.origin.y = top - frame.size.height;
        native.setFrame_display(frame, true);
        native.invalidateShadow();
    }

    /// Makes the main window `height` tall, past the screen if need be:
    /// for drawing a long page whole to an image. It loses its title bar,
    /// which the page draws its own of.
    #[cfg(feature = "shots")]
    pub(crate) fn stretch(window: &Window, height: f32) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let width = f64::from(window.bounds().size.width.as_f32());
        let native = NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .find(|w| {
                !w.styleMask()
                    .contains(NSWindowStyleMask::NonactivatingPanel)
                    && (w.frame().size.width - width).abs() < 1.
            });
        if let Some(native) = native {
            // AppKit holds a titled window's frame to the screen, but not a
            // borderless one's; the page draws its own title bar either way.
            native.setStyleMask(NSWindowStyleMask::Borderless);
            let mut frame = native.frame();
            frame.size.height = f64::from(height);
            native.setFrame_display(frame, false);
        }
    }
}

#[cfg(all(target_os = "macos", feature = "shots"))]
pub(crate) use mac::stretch;
#[cfg(target_os = "macos")]
pub(crate) use mac::{hang, menu_bar_glyph, outside_clicks, status_item};

#[cfg(not(target_os = "macos"))]
mod elsewhere {
    use gpui_kit::*;

    pub(crate) fn menu_bar_glyph() {}

    pub(crate) fn status_item() -> Option<Bounds<Pixels>> {
        None
    }

    pub(crate) fn hang(_: &Window, _: f32) {}

    #[cfg(feature = "shots")]
    pub(crate) fn stretch(_: &Window, _: f32) {}

    pub(crate) fn outside_clicks() -> Option<async_channel::Receiver<()>> {
        None
    }
}

#[cfg(all(not(target_os = "macos"), feature = "shots"))]
pub(crate) use elsewhere::stretch;
#[cfg(not(target_os = "macos"))]
pub(crate) use elsewhere::{hang, menu_bar_glyph, outside_clicks, status_item};
