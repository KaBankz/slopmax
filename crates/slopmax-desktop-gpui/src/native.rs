//! What GPUI does not reach of AppKit: the accent color chosen in System
//! Settings, the menu bar item's glyph and where it sits, and the vibrancy
//! behind a window, as a sidebar or a menu bar panel has it. Elsewhere each
//! does nothing.

/// The material behind a window's transparent parts.
#[derive(Clone, Copy)]
pub(crate) enum Material {
    /// A sidebar's, translucent to the desktop behind.
    Sidebar,
    /// A popover's, as a menu bar panel has it.
    Popover,
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::Cell;

    use gpui_kit::*;
    use objc2::rc::Retained;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSAutoresizingMaskOptions, NSColor, NSColorSpace, NSImage, NSScreen,
        NSStatusBarButton, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
        NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask,
    };
    use objc2_foundation::NSString;

    use super::Material;

    pub(crate) fn system_accent() -> Option<Hsla> {
        let app = NSApplication::sharedApplication(MainThreadMarker::new()?);
        let accent = Cell::new(None);
        let read = block2::StackBlock::new(|| {
            let color =
                NSColor::controlAccentColor().colorUsingColorSpace(&NSColorSpace::sRGBColorSpace());
            accent.set(color.map(|color| Rgba {
                r: color.redComponent() as f32,
                g: color.greenComponent() as f32,
                b: color.blueComponent() as f32,
                a: color.alphaComponent() as f32,
            }));
        });
        app.effectiveAppearance()
            .performAsCurrentDrawingAppearance(&read);
        accent.get().map(Hsla::from)
    }

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

    /// The AppKit window behind GPUI's `window`: of its kind (a panel for a
    /// popup, else a titled window) and its size, the last opened.
    fn native(window: &Window, panel: bool) -> Option<Retained<NSWindow>> {
        let mtm = MainThreadMarker::new()?;
        let bounds = window.bounds();
        NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .filter(|w| {
                w.styleMask()
                    .contains(NSWindowStyleMask::NonactivatingPanel)
                    == panel
                    && (w.frame().size.width - f64::from(bounds.size.width.as_f32())).abs() < 1.
                    && (w.frame().size.height - f64::from(bounds.size.height.as_f32())).abs() < 1.
            })
            .last()
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

    pub(crate) fn hang(window: &Window, height: f32) {
        let Some(native) = native(window, true) else {
            return;
        };
        let mut frame = native.frame();
        let top = frame.origin.y + frame.size.height;
        frame.size.height = f64::from(height);
        frame.origin.y = top - frame.size.height;
        native.setFrame_display(frame, true);
    }

    pub(crate) fn frost(window: &Window, material: Material, radius: f32) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(native) = native(window, matches!(material, Material::Popover)) else {
            return;
        };
        let Some(content) = native.contentView() else {
            return;
        };
        // Once per window.
        if content
            .subviews()
            .iter()
            .any(|view| view.downcast::<NSVisualEffectView>().is_ok())
        {
            return;
        }
        let effect =
            NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), content.bounds());
        effect.setMaterial(match material {
            Material::Sidebar => NSVisualEffectMaterial::Sidebar,
            Material::Popover => NSVisualEffectMaterial::Popover,
        });
        effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        effect.setState(NSVisualEffectState::FollowsWindowActiveState);
        effect.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        if radius > 0. {
            effect.setWantsLayer(true);
            if let Some(layer) = effect.layer() {
                layer.setCornerRadius(f64::from(radius));
                layer.setMasksToBounds(true);
            }
        }
        content.addSubview_positioned_relativeTo(&effect, NSWindowOrderingMode::Below, None);
        native.invalidateShadow();
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::{frost, hang, menu_bar_glyph, outside_clicks, status_item, system_accent};

#[cfg(not(target_os = "macos"))]
mod elsewhere {
    use gpui_kit::*;

    use super::Material;

    pub(crate) fn system_accent() -> Option<Hsla> {
        None
    }

    pub(crate) fn menu_bar_glyph() {}

    pub(crate) fn status_item() -> Option<Bounds<Pixels>> {
        None
    }

    pub(crate) fn frost(_: &Window, _: Material, _: f32) {}

    pub(crate) fn hang(_: &Window, _: f32) {}

    pub(crate) fn outside_clicks() -> Option<async_channel::Receiver<()>> {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) use elsewhere::{
    frost, hang, menu_bar_glyph, outside_clicks, status_item, system_accent,
};
