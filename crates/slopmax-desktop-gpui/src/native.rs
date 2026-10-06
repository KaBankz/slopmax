//! What GPUI does not reach of AppKit: the accent color chosen in System
//! Settings, the menu bar item's glyph and where it sits, the materials
//! AppKit puts behind a sidebar and a menu bar panel, Liquid Glass from
//! macOS 26, and the user's defaults, where a Mac app keeps how its window
//! was left. Elsewhere each does nothing.

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::Cell;

    use gpui_kit::*;
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, NSObjectProtocol};
    use objc2_app_kit::{
        NSApplication, NSAutoresizingMaskOptions, NSColor, NSColorSpace, NSGlassEffectView,
        NSImage, NSScreen, NSSplitViewController, NSSplitViewItem, NSStatusBarButton, NSView,
        NSViewController, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
        NSVisualEffectView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask,
    };
    use objc2_foundation::{NSString, NSUserDefaults};

    pub(crate) fn recall(key: &str) -> Option<f64> {
        let defaults = NSUserDefaults::standardUserDefaults();
        let key = NSString::from_str(key);
        defaults.objectForKey(&key)?;
        Some(defaults.doubleForKey(&key))
    }

    pub(crate) fn remember(key: &str, value: f64) {
        NSUserDefaults::standardUserDefaults().setDouble_forKey(value, &NSString::from_str(key));
    }

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

    /// Puts `backdrop` behind GPUI's view, filling the window.
    fn put_behind(content: &NSView, backdrop: &NSView) {
        backdrop.setFrame(content.bounds());
        backdrop.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        content.addSubview_positioned_relativeTo(backdrop, NSWindowOrderingMode::Below, None);
    }

    pub(crate) fn frost(window: &Window, radius: f32) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(native) = native(window, true) else {
            return;
        };
        let Some(content) = native.contentView() else {
            return;
        };
        // Liquid Glass from macOS 26, as a menu or a popover has it; the
        // popover's vibrancy before.
        let backdrop: Retained<NSView> = if AnyClass::get(c"NSGlassEffectView").is_some() {
            let glass = NSGlassEffectView::new(mtm);
            glass.setCornerRadius(f64::from(radius));
            Retained::into_super(glass)
        } else {
            let effect = NSVisualEffectView::new(mtm);
            effect.setMaterial(NSVisualEffectMaterial::Popover);
            effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            effect.setState(NSVisualEffectState::Active);
            effect.setWantsLayer(true);
            if let Some(layer) = effect.layer() {
                layer.setCornerRadius(f64::from(radius));
                layer.setMasksToBounds(true);
            }
            Retained::into_super(effect)
        };
        put_behind(&content, &backdrop);
        native.invalidateShadow();
    }

    /// The material behind GPUI's sidebar, as AppKit draws a sidebar's:
    /// from macOS 26 its Liquid Glass, a variant of the glass that no public
    /// API makes, and its vibrancy before. GPUI draws the sidebar over it,
    /// and the page covers the rest.
    pub(crate) struct Backdrop {
        material: Retained<NSView>,
    }

    impl Backdrop {
        pub(crate) fn new(window: &Window, width: f32) -> Option<Self> {
            let mtm = MainThreadMarker::new()?;
            let native = native(window, false)?;
            let content = native.contentView()?;
            let material = sidebar_material(mtm).unwrap_or_else(|| {
                let effect = NSVisualEffectView::new(mtm);
                effect.setMaterial(NSVisualEffectMaterial::Sidebar);
                effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                Retained::into_super(effect)
            });
            // As tall as the window, as wide as the sidebar.
            material.setTranslatesAutoresizingMaskIntoConstraints(true);
            put_behind(&content, &material);
            material.setAutoresizingMask(NSAutoresizingMaskOptions::ViewHeightSizable);
            // The window's own background lies under the glass, as under
            // AppKit's sidebar, rather than whatever is behind the window.
            native.setBackgroundColor(Some(&NSColor::windowBackgroundColor()));
            let backdrop = Self { material };
            backdrop.set_width(width);
            Some(backdrop)
        }

        /// Keeps the material as wide as GPUI's sidebar. As the sidebar
        /// slides shut the page covers the material, so only a drag needs
        /// this.
        pub(crate) fn set_width(&self, width: f32) {
            let mut frame = self.material.frame();
            frame.size.width = f64::from(width);
            self.material.setFrame(frame);
        }
    }

    impl Drop for Backdrop {
        fn drop(&mut self) {
            self.material.removeFromSuperview();
        }
    }

    /// The material AppKit dresses a sidebar in: the view enclosing the
    /// sidebar of a split view controller laid out for the purpose in a
    /// window never shown, the rest of which is then dropped. Laid out in
    /// the window itself, the split view would move the window's buttons.
    fn sidebar_material(mtm: MainThreadMarker) -> Option<Retained<NSView>> {
        fn find(
            view: Retained<NSView>,
            pane: &NSView,
            kinds: &[&AnyClass],
        ) -> Option<Retained<NSView>> {
            if !pane.isDescendantOf(&view) {
                return None;
            }
            if kinds.iter().any(|kind| view.isKindOfClass(kind)) {
                return Some(view);
            }
            view.subviews()
                .iter()
                .find_map(|view| find(view, pane, kinds))
        }
        let empty = || {
            let pane = NSViewController::new(mtm);
            pane.setView(&NSView::new(mtm));
            pane
        };
        let sidebar = empty();
        let split = NSSplitViewController::new(mtm);
        split.addSplitViewItem(&NSSplitViewItem::sidebarWithViewController(&sidebar));
        split.addSplitViewItem(&NSSplitViewItem::splitViewItemWithViewController(&empty()));
        let _spare = NSWindow::windowWithContentViewController(&split);
        let view = split.view();
        view.layoutSubtreeIfNeeded();
        let kinds: Vec<&AnyClass> = [c"NSGlassEffectView", c"NSVisualEffectView"]
            .into_iter()
            .filter_map(AnyClass::get)
            .collect();
        let material = find(view, &sidebar.view(), &kinds)?;
        material.removeFromSuperview();
        Some(material)
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::{
    Backdrop, frost, hang, menu_bar_glyph, outside_clicks, recall, remember, status_item,
    system_accent,
};

#[cfg(not(target_os = "macos"))]
mod elsewhere {
    use gpui_kit::*;

    pub(crate) struct Backdrop;

    impl Backdrop {
        pub(crate) fn new(_: &Window, _: f32) -> Option<Self> {
            None
        }

        pub(crate) fn set_width(&self, _: f32) {}
    }

    pub(crate) fn system_accent() -> Option<Hsla> {
        None
    }

    pub(crate) fn menu_bar_glyph() {}

    pub(crate) fn status_item() -> Option<Bounds<Pixels>> {
        None
    }

    pub(crate) fn frost(_: &Window, _: f32) {}

    pub(crate) fn hang(_: &Window, _: f32) {}

    pub(crate) fn outside_clicks() -> Option<async_channel::Receiver<()>> {
        None
    }

    pub(crate) fn recall(_: &str) -> Option<f64> {
        None
    }

    pub(crate) fn remember(_: &str, _: f64) {}
}

#[cfg(not(target_os = "macos"))]
pub(crate) use elsewhere::{
    Backdrop, frost, hang, menu_bar_glyph, outside_clicks, recall, remember, status_item,
    system_accent,
};
