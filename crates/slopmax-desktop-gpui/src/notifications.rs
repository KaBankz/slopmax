//! Posts nudges as the system's own notifications: through the
//! UserNotifications framework on a Mac, a thin adapter over what
//! `slopmax-app` decides to tell. The framework serves only an app with a
//! bundle identifier, so a bare binary from `cargo run` posts nothing and
//! says why in Settings. Elsewhere it does nothing.
//!
//! A click on one opens the app as macOS opens any app. Taking the click
//! to a page would take a delegate class, which is unsafe code, kept to two
//! places in slopmax.

use slopmax_app::alerts::Alert;

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::atomic::{AtomicBool, Ordering};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationSound, UNUserNotificationCenter,
    };

    use super::Alert;

    /// Why notifications cannot be posted here, if they cannot.
    pub(crate) fn unavailable() -> Option<&'static str> {
        NSBundle::mainBundle()
            .bundleIdentifier()
            .is_none()
            .then_some("Notifications need the installed slopmax app; this copy runs outside one.")
    }

    /// The notification center, where the app has one: asking for it
    /// without a bundle identifier raises an exception.
    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        if let Some(why) = unavailable() {
            static SAID: AtomicBool = AtomicBool::new(false);
            if !SAID.swap(true, Ordering::Relaxed) {
                eprintln!("slopmax: not posting notifications: {why}");
            }
            return None;
        }
        Some(UNUserNotificationCenter::currentNotificationCenter())
    }

    /// Posts `alert`, asking leave first: the system asks the person once,
    /// and answers at once after. One posted again under its key replaces
    /// the last.
    pub(crate) fn post(alert: &Alert) {
        let Some(center) = center() else { return };
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(alert.title));
        content.setBody(&NSString::from_str(&alert.body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&alert.key),
            &content,
            None,
        );
        let poster = center.clone();
        let asked = RcBlock::new(move |granted: Bool, _: *mut NSError| {
            if granted.as_bool() {
                poster.addNotificationRequest_withCompletionHandler(&request, None);
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &asked,
        );
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::{post, unavailable};

#[cfg(not(target_os = "macos"))]
mod elsewhere {
    use super::Alert;

    pub(crate) fn unavailable() -> Option<&'static str> {
        Some("slopmax posts notifications on macOS.")
    }

    pub(crate) fn post(_: &Alert) {}
}

#[cfg(not(target_os = "macos"))]
pub(crate) use elsewhere::{post, unavailable};
