//! Whether a Windows machine is awake enough to send a refresh token.
//!
//! A laptop with Modern Standby (S0 low-power idle) wakes by itself for a
//! few seconds at a time with the display off, as a Mac does in a
//! DarkWake, and any machine's network takes a few seconds to come back
//! after a resume. Windows says when it sleeps, wakes and turns the display
//! on or off by callback rather than on request, so slopmax listens from
//! the first refresh it weighs and keeps what it heard.

use std::time::{Duration, Instant};

/// How long the network gets to come back after a resume.
const SETTLE: Duration = Duration::from_secs(15);

/// What Windows reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Event {
    /// The machine is going to sleep.
    Suspend,
    /// It woke by itself: a timer, maintenance, or the network.
    ResumeAutomatic,
    /// Someone woke it.
    ResumeByUser,
    /// The console display came on (or dimmed), or went off.
    Display(bool),
}

/// What Windows has reported so far. Before any report the machine counts
/// as awake.
#[derive(Debug)]
struct Power {
    /// On Modern Standby the display going off is the machine going to
    /// sleep, and it wakes by itself in that state for maintenance.
    modern_standby: bool,
    suspended: bool,
    /// Woke by itself, with nobody at the screen since.
    unattended: bool,
    /// Whether the display is on, once Windows has said.
    display: Option<bool>,
    /// Whether the display came on since the machine last went to sleep.
    seen: bool,
    /// When the machine last resumed, until the network has settled.
    resumed: Option<Instant>,
}

impl Power {
    const fn new() -> Self {
        Self {
            modern_standby: false,
            suspended: false,
            unattended: false,
            display: None,
            seen: false,
            resumed: None,
        }
    }

    fn on(&mut self, event: Event, now: Instant) {
        match event {
            Event::Suspend => {
                self.suspended = true;
                self.unattended = false;
                self.seen = false;
            }
            Event::ResumeAutomatic => {
                self.suspended = false;
                self.resumed = Some(now);
                // On Modern Standby a wake with nobody at the screen is
                // maintenance, held until someone is. A desktop or server
                // woken by a timer or the network may stay unattended, so
                // only the settle applies there: its refreshes must not
                // wait for good.
                if self.modern_standby && !self.seen {
                    self.unattended = true;
                }
            }
            Event::ResumeByUser => {
                self.suspended = false;
                self.unattended = false;
                self.resumed = Some(now);
            }
            Event::Display(on) => {
                let was_off = self.display == Some(false);
                self.display = Some(on);
                if !on {
                    return;
                }
                self.seen = true;
                // Waking from sleep, or leaving Modern Standby, starts the
                // settle; a desktop's screen coming back on does not.
                if self.suspended || self.unattended || (self.modern_standby && was_off) {
                    self.suspended = false;
                    self.unattended = false;
                    self.resumed = Some(now);
                }
            }
        }
    }

    /// Why a refresh should wait at `now`, or `None` when it may go ahead.
    fn held(&mut self, now: Instant) -> Option<String> {
        if self.suspended {
            return Some("token refresh deferred: Windows is going to sleep".into());
        }
        if self.unattended {
            return Some("token refresh deferred: Windows woke by itself for maintenance".into());
        }
        if self.modern_standby && self.display == Some(false) {
            return Some("token refresh deferred: Windows is in Modern Standby".into());
        }
        let since = now.saturating_duration_since(self.resumed?);
        if since < SETTLE {
            let left = (SETTLE - since).as_secs().max(1);
            return Some(format!(
                "token refresh deferred: the network is settling after Windows resumed ({left}s left)"
            ));
        }
        self.resumed = None;
        None
    }
}

#[cfg(windows)]
pub use self::windows::deferral;

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::sync::{Mutex, MutexGuard, Once, PoisonError};
    use std::time::Instant;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Power::{
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, GetPwrCapabilities, POWERBROADCAST_SETTING,
        PowerRegisterSuspendResumeNotification, PowerSettingRegisterNotification,
        SYSTEM_POWER_CAPABILITIES,
    };
    use windows_sys::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
        PBT_POWERSETTINGCHANGE,
    };

    use super::{Event, Power};

    static POWER: Mutex<Power> = Mutex::new(Power::new());
    static LISTEN: Once = Once::new();

    /// Why a refresh should wait, or `None` when it may go ahead. A machine
    /// whose reports can't be had never holds a refresh back.
    pub fn deferral() -> Option<String> {
        LISTEN.call_once(listen);
        power().held(Instant::now())
    }

    fn power() -> MutexGuard<'static, Power> {
        POWER.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks Windows for sleep, wake and display reports, for the life of
    /// the process. Windows reports the display's state at once.
    #[allow(unsafe_code)]
    fn listen() {
        let mut capabilities = SYSTEM_POWER_CAPABILITIES::default();
        // SAFETY: the pointer is to a live, writable SYSTEM_POWER_CAPABILITIES.
        if unsafe { GetPwrCapabilities(&mut capabilities) } {
            power().modern_standby = capabilities.AoAc;
        }
        // Windows keeps the parameters' address for as long as the
        // registration lasts, which is the life of the process.
        let subscribe = |callback: extern "system" fn(*const c_void, u32, *const c_void) -> u32| {
            Box::into_raw(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                Callback: Some(callback),
                Context: std::ptr::null_mut(),
            }))
            .cast::<c_void>()
        };
        let mut handle = std::ptr::null_mut();
        // SAFETY: the parameters are leaked, so they outlive the
        // registration, and `handle` is a live out-pointer.
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                subscribe(on_sleep),
                &mut handle,
            )
        };
        debug_assert_eq!(status, ERROR_SUCCESS, "sleep and wake reports");
        let mut handle = std::ptr::null_mut();
        // SAFETY: as above; the GUID is a live constant.
        let status = unsafe {
            PowerSettingRegisterNotification(
                &GUID_CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_CALLBACK,
                subscribe(on_setting),
                &mut handle,
            )
        };
        debug_assert_eq!(status, ERROR_SUCCESS, "display reports");
    }

    /// Sleep and wake.
    extern "system" fn on_sleep(_: *const c_void, event: u32, _: *const c_void) -> u32 {
        let event = match event {
            PBT_APMSUSPEND => Event::Suspend,
            PBT_APMRESUMEAUTOMATIC => Event::ResumeAutomatic,
            PBT_APMRESUMESUSPEND => Event::ResumeByUser,
            _ => return 0,
        };
        power().on(event, Instant::now());
        0
    }

    /// The console display: 0 off, 1 on, 2 dimmed.
    #[allow(unsafe_code)]
    extern "system" fn on_setting(_: *const c_void, event: u32, setting: *const c_void) -> u32 {
        if event != PBT_POWERSETTINGCHANGE || setting.is_null() {
            return 0;
        }
        let setting = setting.cast::<POWERBROADCAST_SETTING>();
        // SAFETY: for a setting change Windows passes a POWERBROADCAST_SETTING
        // followed by `DataLength` bytes of data, read here through the raw
        // pointer and only as far as that length.
        let state = unsafe {
            let guid = (*setting).PowerSetting;
            let display = GUID_CONSOLE_DISPLAY_STATE;
            let ours = (guid.data1, guid.data2, guid.data3, guid.data4)
                == (display.data1, display.data2, display.data3, display.data4);
            if !ours || (*setting).DataLength < 4 {
                return 0;
            }
            (&raw const (*setting).Data).cast::<u32>().read_unaligned()
        };
        power().on(Event::Display(state != 0), Instant::now());
        0
    }

    #[cfg(test)]
    pub(super) fn reported() -> Option<bool> {
        power().display
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, seconds: u64) -> Instant {
        start + Duration::from_secs(seconds)
    }

    #[test]
    fn a_modern_standby_maintenance_wake_holds_refreshes_until_someone_is_there() {
        let start = Instant::now();
        let mut power = Power {
            modern_standby: true,
            ..Power::new()
        };
        power.on(Event::Display(true), start);
        assert_eq!(power.held(start), None);
        // The lid closes: the display goes off, and the laptop is asleep.
        power.on(Event::Display(false), at(start, 1));
        assert_eq!(
            power.held(at(start, 1)).as_deref(),
            Some("token refresh deferred: Windows is in Modern Standby")
        );
        power.on(Event::Suspend, at(start, 2));
        // Hours later it wakes for maintenance, display still off.
        power.on(Event::ResumeAutomatic, at(start, 9000));
        assert_eq!(
            power.held(at(start, 9100)).as_deref(),
            Some("token refresh deferred: Windows woke by itself for maintenance")
        );
        // The lid opens: the display comes on and the network settles.
        power.on(Event::Display(true), at(start, 20_000));
        assert_eq!(
            power.held(at(start, 20_005)).as_deref(),
            Some(
                "token refresh deferred: the network is settling after Windows resumed (10s left)"
            )
        );
        assert_eq!(power.held(at(start, 20_015)), None);
        assert_eq!(power.held(at(start, 20_016)), None);
    }

    #[test]
    fn a_desktop_woken_by_a_timer_waits_only_for_the_network() {
        let start = Instant::now();
        let mut power = Power::new();
        power.on(Event::Display(false), start);
        assert_eq!(power.held(start), None, "a screen off is not sleep");
        power.on(Event::Suspend, at(start, 1));
        assert!(power.held(at(start, 1)).is_some(), "going to sleep");
        power.on(Event::ResumeAutomatic, at(start, 3600));
        assert!(power.held(at(start, 3610)).is_some(), "settling");
        assert_eq!(power.held(at(start, 3615)), None, "nobody needs to come");
    }

    #[test]
    fn someone_waking_the_machine_lets_refreshes_go_after_the_settle() {
        let start = Instant::now();
        let mut power = Power {
            modern_standby: true,
            ..Power::new()
        };
        power.on(Event::Suspend, start);
        power.on(Event::ResumeAutomatic, at(start, 60));
        assert!(power.held(at(start, 600)).is_some());
        power.on(Event::ResumeByUser, at(start, 700));
        assert!(power.held(at(start, 701)).is_some(), "settling");
        assert_eq!(power.held(at(start, 715)), None);
    }

    #[test]
    fn a_desktop_screen_coming_back_does_not_hold_refreshes() {
        let start = Instant::now();
        let mut power = Power::new();
        power.on(Event::Display(false), start);
        power.on(Event::Display(true), at(start, 60));
        assert_eq!(power.held(at(start, 61)), None);
    }

    #[test]
    fn nothing_reported_holds_nothing_back() {
        assert_eq!(Power::new().held(Instant::now()), None);
    }

    /// The test machine is awake, and Windows tells a listener the
    /// display's state as soon as it asks: the callbacks are wired up.
    #[cfg(windows)]
    #[test]
    fn this_windows_machine_reads_as_awake() {
        assert_eq!(deferral(), None);
        let asked = Instant::now();
        while windows::reported().is_none() && asked.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(windows::reported().is_some(), "no display report");
        assert_eq!(deferral(), None);
    }
}
