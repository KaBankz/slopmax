//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar item whose panel shows each pool at a glance.
//!
//! It wears slopmax's own design on every system, in gpui-kit's components:
//! quiet light and dark themes, IBM Plex Sans, and Lucide's icons. Its
//! sidebar slides away and back from its button, at once from ⌃⌘S or the
//! View menu, resizes by its edge, hides when dragged narrow, and is left
//! as the user leaves it.

mod access;
mod accounts;
mod assets;
mod motion;
mod native;
mod notifications;
mod overview;
mod panel;
mod prefs;
mod settings;
#[cfg(feature = "shots")]
mod shots;
mod theme;
mod ui;
mod usage;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::input::{self, InputState};
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::{ActiveTheme as _, Disableable, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_tray::{Icon, Tray};
use slopmax_app::history::Range;
use slopmax_app::view;
use slopmax_app::{App as Slopmax, Proxy, Snapshot};
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::prefs::Prefs;
use crate::theme::Colors;
use crate::ui::{caption, dot, field, icon, logo, panel, push, segmented, tool};

actions!(
    slopmax,
    [
        OpenWindow,
        Refresh,
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        CloseWindow,
        Minimize,
        Zoom,
        SignInClaude,
        SignInChatGpt,
        ImportLogins,
        AddKey,
        OpenSettings,
        ToggleSidebar
    ]
);
actions!(sidebar, [SelectPrevious, SelectNext]);

const TRAY_ICON: &[u8] = include_bytes!("../../../assets/tray.svg");

/// The API-key providers, in the order the key row offers them.
const KEYS: [ProviderId; 3] = [ProviderId::Anthropic, ProviderId::OpenAI, ProviderId::Xai];

/// The height of the strip across the window's top: the sidebar's mark and
/// the page's title and tools.
const HEADER: Pixels = px(52.);
/// Where the window's own buttons leave room on a Mac, and elsewhere.
const LEAD: f32 = if cfg!(target_os = "macos") { 84. } else { 16. };
/// The sidebar's width at first, and the least and most a drag of its edge
/// leaves it.
const SIDEBAR: f32 = 220.;
const SIDEBAR_MIN: f32 = 190.;
const SIDEBAR_MAX: f32 = 340.;
/// Dragged narrower than this, the sidebar hides.
const SIDEBAR_COLLAPSE: f32 = 130.;
/// The page's margin from the window's edges.
const MARGIN: f32 = 32.;
/// How often the charts reread the ledger while they show.
/// The widest a page's content grows.
const CONTENT: f32 = 1080.;
const HISTORY_EVERY: Duration = Duration::from_secs(60);

/// A page of the window, as the sidebar lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    /// How everything stands, where the window opens.
    Overview,
    /// A provider's accounts.
    Provider(ProviderId),
    /// What went through slopmax.
    Usage,
    /// How well it went: failover, caching, and speed.
    Performance,
    Agents,
    /// Keys for other tools, and compatible endpoints.
    Access,
    /// The setup checks `slopmax doctor` runs.
    Diagnostics,
    Settings,
}

impl Section {
    fn title(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Provider(provider) => provider.spec().title,
            Self::Usage => "Usage",
            Self::Performance => "Performance",
            Self::Agents => "Agents",
            Self::Access => "Access",
            Self::Diagnostics => "Diagnostics",
            Self::Settings => "Settings",
        }
    }

    /// Its icon in the sidebar.
    fn icon(self) -> IconName {
        match self {
            Self::Overview => IconName::LayoutDashboard,
            Self::Provider(_) => IconName::Users,
            Self::Usage => IconName::ChartColumn,
            Self::Performance => IconName::Zap,
            Self::Agents => IconName::Bot,
            Self::Access => IconName::KeyRound,
            Self::Diagnostics => IconName::Stethoscope,
            Self::Settings => IconName::Settings,
        }
    }
}

/// What the menu bar item and the app's actions reach.
struct Shared {
    app: Arc<Slopmax>,
    tray: Option<Tray>,
    window: Option<AnyWindowHandle>,
    /// What the window shows, to turn it to a page.
    main: Option<WeakEntity<Main>>,
    /// The menu bar panel, while it is open.
    panel: Option<AnyWindowHandle>,
}

impl Global for Shared {}

fn main() -> anyhow::Result<()> {
    // Drawing the pages to images posts nothing.
    let shooting = std::env::var_os("SLOPMAX_SHOTS").is_some();
    let app = Arc::new(Slopmax::start_with(!shooting)?);
    // Closing the window leaves the menu bar item, whose panel quits the
    // app; clicking the Dock icon opens the window again.
    let application = gpui_kit::application()
        .with_assets(assets::AppAssets)
        .with_quit_mode(QuitMode::Explicit);
    application.on_reopen(open_window);
    application.run(move |cx| {
        gpui_kit::init(cx);
        cx.set_global(Prefs::load());
        theme::init(cx);
        cx.on_action(|_: &OpenWindow, cx| open_window(cx));
        cx.on_action(|_: &OpenSettings, cx| show(Section::Settings, cx));
        cx.on_action(|_: &AddKey, cx| show(Section::Access, cx));
        cx.on_action(|_: &Refresh, cx| cx.global::<Shared>().app.refresh());
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
        cx.on_action(|_: &CloseWindow, cx| front_window(cx, |window| window.remove_window()));
        cx.on_action(|_: &Minimize, cx| front_window(cx, |window| window.minimize_window()));
        cx.on_action(|_: &Zoom, cx| front_window(cx, |window| window.zoom_window()));
        cx.on_action(|_: &SignInClaude, cx| {
            cx.global::<Shared>().app.sign_in(ProviderId::Claude);
        });
        cx.on_action(|_: &SignInChatGpt, cx| {
            cx.global::<Shared>().app.sign_in(ProviderId::Codex);
        });
        cx.on_action(|_: &ImportLogins, cx| cx.global::<Shared>().app.import());
        keys(cx);
        menus(cx, cx.global::<Prefs>().sidebar_hidden);
        panel::init(cx);
        let tray = menu_bar_icon(cx)
            .inspect_err(|e| eprintln!("slopmax: no menu bar icon: {e}"))
            .ok();
        cx.set_global(Shared {
            app,
            tray,
            window: None,
            main: None,
            panel: None,
        });
        open_window(cx);
        if !shooting {
            notify(cx);
        }
        #[cfg(feature = "shots")]
        shots::start(cx);
    });
    Ok(())
}

/// The usual shortcuts, and the sidebar's arrow keys.
/// Posts the nudges slopmax-app hands over as the system's notifications.
fn notify(cx: &mut App) {
    if let Some(mut alerts) = cx.global::<Shared>().app.alerts() {
        cx.spawn(async move |cx: &mut AsyncApp| {
            while let Some(alert) = alerts.recv().await {
                cx.update(|_| notifications::post(&alert));
            }
        })
        .detach();
    }
}

fn keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-r", Refresh, None),
        KeyBinding::new("cmd-o", OpenWindow, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("ctrl-cmd-s", ToggleSidebar, None),
        KeyBinding::new("up", SelectPrevious, Some("Sidebar")),
        KeyBinding::new("down", SelectNext, Some("Sidebar")),
    ]);
}

/// The app's menus. Edit's items reach the focused text field; View's
/// first item says what it will do to the sidebar.
fn menus(cx: &mut App, sidebar_hidden: bool) {
    cx.set_menus([
        Menu::new("slopmax").items([
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide slopmax", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit slopmax", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("Sign In with Claude…", SignInClaude),
            MenuItem::action("Sign In with ChatGPT…", SignInChatGpt),
            MenuItem::action("Import Logins", ImportLogins),
            MenuItem::action("Add an API Key…", AddKey),
            MenuItem::separator(),
            MenuItem::action("Close Window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", input::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", input::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", input::Paste, OsAction::Paste),
            MenuItem::os_action("Select All", input::SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action(
                if sidebar_hidden {
                    "Show Sidebar"
                } else {
                    "Hide Sidebar"
                },
                ToggleSidebar,
            ),
            MenuItem::separator(),
            MenuItem::action("Refresh Usage", Refresh),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
        ]),
    ]);
}

/// Runs a window command on the window in front.
fn front_window(cx: &mut App, command: impl FnOnce(&mut Window)) {
    if let Some(window) = cx.active_window() {
        let _ = window.update(cx, |_, window, _| command(window));
    }
}

/// The menu bar item: each pool's use as its title, and the panel on a
/// click.
fn menu_bar_icon(cx: &mut App) -> gpui_tray::Result<Tray> {
    let tray = Tray::builder()
        .title("slopmax")
        .tooltip("slopmax")
        .on_activate_with(|_, cx| panel::toggle(cx));
    // A Mac menu bar wants a template image, which gpui-tray cannot give it:
    // it sizes an icon by its pixels and keeps its colors. So on a Mac the
    // app sets the item's image itself; elsewhere the tray takes the mark.
    if cfg!(target_os = "macos") {
        let tray = tray.build(cx)?;
        native::menu_bar_glyph();
        Ok(tray)
    } else {
        let image = Image::from_bytes(ImageFormat::Svg, TRAY_ICON.to_vec());
        tray.icon(Icon::from_gpui(&image, cx)?).build(cx)
    }
}

/// Brings the window forward, opening it again if it was closed.
fn open_window(cx: &mut App) {
    panel::dismiss(cx);
    if let Some(window) = cx.global::<Shared>().window
        && window
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        cx.activate(true);
        return;
    }
    let app = cx.global::<Shared>().app.clone();
    let options = WindowOptions {
        titlebar: Some(TitlebarOptions {
            title: Some("slopmax".into()),
            // Centered in the header's height.
            traffic_light_position: Some(point(px(18.), (HEADER - px(14.)) / 2.)),
            ..TitleBar::title_bar_options()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1160.), px(800.)),
            cx,
        ))),
        window_min_size: Some(size(px(880.), px(560.))),
        ..TitleBar::window_options()
    };
    match gpui_kit::open_window(options, cx, |window, cx| {
        theme::apply(window, cx);
        cx.new(|cx| Main::new(app, window, cx))
    }) {
        Ok((window, main)) => {
            let shared = cx.global_mut::<Shared>();
            shared.window = Some(window);
            shared.main = Some(main.downgrade());
        }
        Err(e) => eprintln!("slopmax: could not open the window: {e:#}"),
    }
    cx.activate(true);
}

/// Brings the window forward at `section`.
fn show(section: Section, cx: &mut App) {
    open_window(cx);
    if let Some(main) = cx
        .global::<Shared>()
        .main
        .as_ref()
        .and_then(WeakEntity::upgrade)
    {
        main.update(cx, |main, cx| main.go(section, cx));
    }
}

struct Main {
    app: Arc<Slopmax>,
    snapshot: Snapshot,
    section: Section,
    key: Entity<InputState>,
    key_provider: ProviderId,
    paste: Entity<InputState>,
    /// The Access page's fields: a client key's name and models, and a
    /// compatible endpoint's address, API, models, key, and name.
    access: access::Fields,
    /// The span the charts show.
    range: Range,
    /// When the charts' history, and today's, were last asked for.
    asked: Option<Instant>,
    asked_today: Option<Instant>,
    /// The accounts whose reset credits show.
    credits_open: HashSet<String>,
    /// The account whose reset credit waits on a second press to redeem.
    confirming: Option<String>,
    sidebar: Sidebar,
    /// The sidebar's list, which the arrow keys move through while it has
    /// focus.
    sidebar_focus: FocusHandle,
    _tasks: [Task<()>; 2],
    _system: [Subscription; 2],
}

/// The sidebar as the user leaves it: its width, whether it hides, and how
/// it last changed.
#[derive(Debug, Clone, Copy)]
struct Sidebar {
    width: f32,
    hidden: bool,
    /// The slides so far, so that each plays afresh.
    slides: usize,
    /// The latest slide, while it is the latest change: a press of its
    /// button slides it, while the keyboard, a menu, or a drag of its edge
    /// shows or hides it at once.
    slide: Option<Slide>,
    /// A drag of its edge in progress, and the width it began at, which a
    /// drag that hides the sidebar leaves it to come back at.
    dragging: bool,
    dragged_from: f32,
}

impl Sidebar {
    fn recall(prefs: &Prefs) -> Self {
        Self {
            width: prefs.sidebar_width.clamp(SIDEBAR_MIN, SIDEBAR_MAX),
            hidden: prefs.sidebar_hidden,
            slides: 0,
            slide: None,
            dragging: false,
            dragged_from: SIDEBAR,
        }
    }

    fn remember(self, cx: &mut App) {
        let prefs = cx.global_mut::<Prefs>();
        prefs.sidebar_width = self.width;
        prefs.sidebar_hidden = self.hidden;
        prefs.save();
    }

    /// The share of its width it comes to rest at.
    fn rest(self) -> f32 {
        if self.hidden { 0. } else { 1. }
    }

    /// The share of its width showing now: where a slide under way has
    /// reached, or where it rests.
    fn shown(self) -> f32 {
        match self.slide {
            Some(slide) => {
                let along = slide.started.elapsed().as_secs_f32() / slide.length.as_secs_f32();
                slide.from + (self.rest() - slide.from) * motion::ease_in_out(along.min(1.))
            }
            None => self.rest(),
        }
    }

    /// How wide it shows `along` its slide, from 0 to 1.
    fn open(self, along: f32) -> f32 {
        let shown = match self.slide {
            Some(slide) => slide.from + (self.rest() - slide.from) * along,
            None => self.rest(),
        };
        self.width * shown
    }

    /// Hides it, or shows it again; sliding, from wherever a slide under
    /// way has reached, in as much of a full slide's time as it has left to
    /// go.
    fn toggle(&mut self, slide: bool) {
        let from = self.shown();
        self.hidden = !self.hidden;
        self.slides += 1;
        self.slide = slide.then(|| Slide {
            from,
            started: Instant::now(),
            length: motion::SLIDE.mul_f32((self.rest() - from).abs().max(0.3)),
        });
    }
}

/// A slide of the sidebar: the share of its width it set out from, when,
/// and for how long.
#[derive(Debug, Clone, Copy)]
struct Slide {
    from: f32,
    started: Instant,
    length: Duration,
}

impl Main {
    fn new(app: Arc<Slopmax>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let key = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste an API key")
                .masked(true)
        });
        let paste = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Browser on another machine? Paste the address it ended on")
        });
        // Each change to the snapshot redraws the window and the menu bar.
        let mut changes = app.subscribe();
        let follow = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                let snapshot = changes.borrow_and_update().clone();
                let drawn = this.update(cx, |main, cx| {
                    if let Some(report) = &snapshot.report
                        && let Some(tray) = cx.global::<Shared>().tray.clone()
                    {
                        let _ = tray.set_title(Some(view::menu_bar(report, Timestamp::now())), cx);
                    }
                    main.snapshot = snapshot;
                    cx.notify();
                });
                if drawn.is_err() || changes.changed().await.is_err() {
                    break;
                }
            }
        });
        // Countdowns move every second; the charts reread the ledger now and
        // then.
        let tick = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |main, cx| main.tick(cx)).is_err() {
                    break;
                }
            }
        });
        // The window turns light or dark with the system, when the user
        // leaves it to the system.
        let appearance =
            cx.observe_window_appearance(window, |_, window, cx| theme::apply(window, cx));
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if window.is_window_active() {
                panel::dismiss(cx);
            }
        });
        let sidebar = Sidebar::recall(cx.global::<Prefs>());
        // The sidebar has focus to begin with, so the arrow keys move
        // through its pages.
        let sidebar_focus = cx.focus_handle();
        window.focus(&sidebar_focus, cx);
        let mut main = Self {
            snapshot: app.snapshot(),
            app,
            section: Section::Overview,
            key,
            key_provider: ProviderId::Anthropic,
            paste,
            access: access::Fields::new(window, cx),
            range: Range::default(),
            asked: None,
            asked_today: None,
            credits_open: HashSet::new(),
            confirming: None,
            sidebar,
            sidebar_focus,
            _tasks: [follow, tick],
            _system: [appearance, activation],
        };
        main.load_today();
        main
    }

    fn tick(&mut self, cx: &mut Context<Self>) {
        let stale = |asked: Option<Instant>| asked.is_none_or(|at| at.elapsed() >= HISTORY_EVERY);
        match self.section {
            Section::Usage | Section::Performance => {
                if stale(self.asked) {
                    self.load_history();
                }
            }
            section => {
                if section == Section::Overview && stale(self.asked_today) {
                    self.load_today();
                }
                cx.notify();
            }
        }
    }

    fn load_history(&mut self) {
        self.app.load_history(self.range);
        self.asked = Some(Instant::now());
    }

    fn load_today(&mut self) {
        self.app.load_today();
        self.asked_today = Some(Instant::now());
    }

    /// Shows `section`, reading what it charts.
    fn go(&mut self, section: Section, cx: &mut Context<Self>) {
        if self.section == section {
            return;
        }
        self.section = section;
        match section {
            Section::Usage | Section::Performance => self.load_history(),
            Section::Overview => self.load_today(),
            Section::Diagnostics
                if !matches!(self.snapshot.doctor, slopmax_app::Doctor::Running) =>
            {
                self.app.check_setup();
            }
            _ => {}
        }
        cx.notify();
    }

    /// The pages in the sidebar's order: the overview, each provider with
    /// accounts, the charts, then setup.
    fn sections(&self, now: Timestamp) -> Vec<Section> {
        let providers = self
            .snapshot
            .report
            .as_ref()
            .map(|report| view::groups(report, now))
            .unwrap_or_default()
            .into_iter()
            .map(|group| Section::Provider(group.provider));
        std::iter::once(Section::Overview)
            .chain(providers)
            .chain([
                Section::Usage,
                Section::Performance,
                Section::Agents,
                Section::Access,
                Section::Diagnostics,
                Section::Settings,
            ])
            .collect()
    }

    /// Moves the selection `by` pages, as an arrow key does in a list.
    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let sections = self.sections(Timestamp::now());
        let at = sections
            .iter()
            .position(|s| *s == self.section)
            .unwrap_or(0);
        let next = at.saturating_add_signed(by).min(sections.len() - 1);
        self.go(sections[next], cx);
    }

    /// Hides the sidebar, or shows it again: sliding when its button is
    /// pressed, and at once from the keyboard or a menu, as often as those
    /// are used.
    fn toggle_sidebar(&mut self, slide: bool, cx: &mut Context<Self>) {
        self.sidebar.toggle(slide);
        self.sidebar.remember(cx);
        menus(cx, self.sidebar.hidden);
        cx.notify();
    }

    /// Follows a drag of the sidebar's edge: it narrows and widens within its
    /// bounds, and dragged narrow enough, hides. A move without the button
    /// held ends a drag whose release fell outside the window.
    fn drag_sidebar(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if !self.sidebar.dragging {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            self.end_drag(cx);
            return;
        }
        let x = event.position.x.as_f32();
        if x < SIDEBAR_COLLAPSE {
            self.sidebar.hidden = true;
            self.sidebar.width = self.sidebar.dragged_from;
            self.sidebar.dragging = false;
            self.sidebar.slide = None;
            self.sidebar.remember(cx);
            menus(cx, true);
        } else {
            self.sidebar.width = x.clamp(SIDEBAR_MIN, SIDEBAR_MAX);
        }
        cx.notify();
    }

    fn end_drag(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.dragging {
            self.sidebar.dragging = false;
            self.sidebar.remember(cx);
            cx.notify();
        }
    }

    /// The sidebar: slopmax's mark, the pages in groups with each provider
    /// among them, and how the proxy stands at its foot.
    fn sidebar(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> Div {
        let report = self.snapshot.report.as_ref();
        let groups = report.map(|r| view::groups(r, now)).unwrap_or_default();
        let attention = report.map(|r| view::attention(r, now)).unwrap_or_default();
        let mut list = v_flex()
            .id("sidebar-list")
            .size_full()
            .px(px(8.))
            .pb(px(12.))
            .gap(px(1.))
            .overflow_y_scroll()
            .track_focus(&self.sidebar_focus)
            .key_context("Sidebar")
            .on_action(cx.listener(|main, _: &SelectPrevious, _, cx| main.step(-1, cx)))
            .on_action(cx.listener(|main, _: &SelectNext, _, cx| main.step(1, cx)))
            .role(Role::List)
            .aria_label("Sidebar")
            .child(self.item(Section::Overview, None, c, cx))
            .child(sidebar_heading("Accounts", c));
        if groups.is_empty() {
            list = list.child(
                div()
                    .px(px(10.))
                    .h(px(30.))
                    .flex()
                    .items_center()
                    .text_size(px(ui::BODY))
                    .text_color(c.faint)
                    .child("None yet"),
            );
        }
        for group in &groups {
            // The worst of what wants a look marks the provider; else its
            // count of accounts.
            let alert = attention
                .iter()
                .filter(|a| a.provider == group.provider)
                .map(|a| a.tone)
                .filter(|tone| matches!(tone, Tone::Warn | Tone::Bad))
                .max_by_key(|tone| *tone == Tone::Bad);
            let trailing = match alert {
                Some(tone) => dot(c.tone(tone)).into_any_element(),
                None => div()
                    .font_features(theme::tabular())
                    .text_size(px(ui::SMALL))
                    .text_color(c.faint)
                    .child(group.accounts.len().to_string())
                    .into_any_element(),
            };
            list = list.child(self.item(Section::Provider(group.provider), Some(trailing), c, cx));
        }
        list = list
            .child(sidebar_heading("Activity", c))
            .child(self.item(Section::Usage, None, c, cx))
            .child(self.item(Section::Performance, None, c, cx))
            .child(sidebar_heading("Setup", c))
            .child(self.item(Section::Agents, None, c, cx))
            .child(self.item(Section::Access, None, c, cx))
            .child(self.item(Section::Diagnostics, None, c, cx))
            .child(self.item(Section::Settings, None, c, cx));
        v_flex()
            .h_full()
            .bg(c.sidebar)
            .border_r_1()
            .border_color(c.border)
            .child(
                // Where the window's buttons sit on a Mac, and a strip to
                // drag the window by.
                ui::drag_region("sidebar-header")
                    .h(HEADER)
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .pl(px(LEAD))
                    .pr(px(8.))
                    .gap(px(8.))
                    .child(logo(18., c))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.fg)
                            .child("slopmax"),
                    )
                    .child(self.sidebar_toggle(true, cx)),
            )
            .child(div().flex_1().min_h_0().child(list))
            .child(self.proxy_status(c, cx))
    }

    /// A row of the sidebar: its icon, its title, and what trails it. A
    /// press chooses it.
    fn item(
        &self,
        section: Section,
        trailing: Option<AnyElement>,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.section == section;
        let slot = div()
            .size(px(16.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center();
        let leading = slot.child(icon(
            section.icon(),
            15.,
            if selected { c.fg } else { c.muted },
        ));
        let (hover, fg) = (c.hover, c.fg);
        h_flex()
            .id(SharedString::from(format!("go-{section:?}")))
            .h(px(30.))
            .px(px(10.))
            .gap(px(10.))
            .rounded(px(6.))
            .text_size(px(ui::BODY))
            .map(|row| {
                if selected {
                    row.bg(c.selected)
                        .text_color(c.fg)
                        .font_weight(FontWeight::MEDIUM)
                } else {
                    row.text_color(cx.theme().sidebar_foreground)
                        .cursor_pointer()
                        .hover(move |row| row.bg(hover).text_color(fg))
                }
            })
            .role(Role::ListItem)
            .aria_label(section.title())
            .aria_selected(selected)
            .child(leading)
            .child(div().flex_1().min_w_0().truncate().child(section.title()))
            .children(trailing)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |main, _, window, cx| {
                    window.focus(&main.sidebar_focus, cx);
                    main.go(section, cx);
                }),
            )
            // What a screen reader presses.
            .on_click(cx.listener(move |main, _, _, cx| main.go(section, cx)))
    }

    /// How the proxy stands, at the sidebar's foot; a click opens Settings.
    fn proxy_status(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let (state, color) = match &self.snapshot.proxy {
            Proxy::Running { version } => (format!("Running {version}"), c.good),
            Proxy::Starting => ("Starting…".to_owned(), c.warn),
            Proxy::Checking => ("Looking for the proxy…".to_owned(), c.muted),
            Proxy::Stopped => ("Stopped".to_owned(), c.bad),
        };
        let hover = c.hover;
        div()
            .px(px(8.))
            .py(px(10.))
            .border_t_1()
            .border_color(c.border)
            .child(
                h_flex()
                    .id("proxy-status")
                    .gap(px(10.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(move |row| row.bg(hover))
                    .role(Role::Button)
                    .aria_label(format!("Proxy: {state}"))
                    .child(dot(color))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(ui::SMALL))
                                    .text_color(c.fg)
                                    .child(state),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(11.5))
                                    .text_color(c.faint)
                                    .child(self.snapshot.address.clone()),
                            ),
                    )
                    .on_click(cx.listener(|main, _, _, cx| main.go(Section::Settings, cx))),
            )
    }

    /// The sidebar's toggle: in the sidebar's header while it shows, and in
    /// the page's while it hides.
    fn sidebar_toggle(&self, shown: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let tip = if shown {
            "Hide Sidebar"
        } else {
            "Show Sidebar"
        };
        let id = if shown {
            "hide-sidebar"
        } else {
            "show-sidebar"
        };
        tool(id, IconName::PanelLeft, tip)
            .on_click(cx.listener(|main, _, _, cx| main.toggle_sidebar(true, cx)))
    }

    /// The page's header: its title, and what acts on it.
    fn header(&self, c: &Colors, cx: &mut Context<Self>) -> TitleBar {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let tools = h_flex()
            .gap(px(6.))
            // A press on a control is a click, never a window drag.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
        let tools = match self.section {
            Section::Overview | Section::Provider(_) => {
                let app = self.app.clone();
                tools
                    .child(
                        tool("refresh", IconName::RefreshCw, "Refresh usage")
                            .disabled(!running)
                            .on_click(move |_, _, _| app.refresh()),
                    )
                    // Every way to add one is on the Access page.
                    .child(
                        push("add", "Add account")
                            .icon(IconName::Plus)
                            .primary()
                            .on_click(cx.listener(|main, _, _, cx| main.go(Section::Access, cx))),
                    )
            }
            Section::Usage | Section::Performance => tools.child(segmented(
                "range",
                Range::ALL.map(|range| (range, view::range_title(range))),
                self.range,
                |main: &mut Self, range, cx| {
                    main.range = range;
                    main.load_history();
                    cx.notify();
                },
                c,
                cx,
            )),
            Section::Agents | Section::Access | Section::Settings => tools,
            Section::Diagnostics => {
                let checking = matches!(self.snapshot.doctor, slopmax_app::Doctor::Running);
                let app = self.app.clone();
                tools.child(
                    push("check-again", "Check again")
                        .disabled(checking)
                        .on_click(move |_, _, _| app.check_setup()),
                )
            }
        };
        TitleBar::new()
            .h(HEADER)
            .pr(px(16.))
            .bg(c.bg)
            .border_0()
            .child(
                h_flex()
                    .gap(px(8.))
                    .when(self.sidebar.hidden, |title| {
                        title.child(self.sidebar_toggle(false, cx))
                    })
                    .child(
                        div()
                            .text_size(px(ui::TITLE))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.fg)
                            .child(self.section.title()),
                    ),
            )
            .child(tools)
    }

    /// What slopmax last reports, at the window's foot: it rises into place
    /// as it arrives, and leaves at once when dismissed.
    fn notice(&self, c: &Colors) -> Option<impl IntoElement> {
        let notice = self.snapshot.notice.as_ref()?;
        let app = self.app.clone();
        let (name, color) = if notice.error {
            (IconName::CircleX, c.bad)
        } else {
            (IconName::CircleCheck, c.good)
        };
        // A new notice rises afresh; the same one stays where it is.
        let key = SharedString::from(format!("notice-{}", notice.text));
        // Floats over the corner, so it never moves what is under the pointer.
        let toast = h_flex()
            .absolute()
            .right(px(20.))
            .w(px(400.))
            .p(px(10.))
            .pl(px(14.))
            .gap(px(10.))
            .rounded(px(8.))
            .border_1()
            .border_color(c.border)
            .bg(c.popover)
            .shadow(vec![
                BoxShadow::new(
                    px(0.),
                    px(8.),
                    black().opacity(if c.dark { 0.4 } else { 0.08 }),
                )
                .blur_radius(px(24.)),
            ])
            .child(icon(name, 16., color))
            .child(
                div()
                    .flex_1()
                    .text_size(px(ui::BODY))
                    .text_color(c.fg)
                    .child(notice.text.clone()),
            )
            .child(
                tool("dismiss", IconName::Close, "Dismiss")
                    .on_click(move |_, _, _| app.dismiss_notice()),
            );
        let rise = Animation::new(motion::APPEAR).with_easing(motion::ease_out);
        Some(toast.with_animation(key, rise, |toast, along| {
            toast.bottom(px(20. - 8. * (1. - along))).opacity(along)
        }))
    }

    /// A sign-in in progress: what to do in the browser, or the code to
    /// enter, above whatever page shows.
    fn sign_in(&self, c: &Colors) -> Option<impl IntoElement> {
        let sign_in = view::sign_in(self.snapshot.sign_in.as_ref()?);
        let (app, cancel) = (self.app.clone(), self.app.clone());
        let paste = self.paste.clone();
        let mut body = panel(c).p(px(16.)).gap(px(12.)).child(
            h_flex()
                .gap(px(12.))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.))
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(sign_in.title.clone()),
                        )
                        .child(caption(sign_in.detail.clone(), c)),
                )
                .child(push("cancel-sign-in", "Cancel").on_click(move |_, _, _| {
                    cancel.cancel_sign_in();
                })),
        );
        if let Some(code) = sign_in.code {
            body = body.child(
                div()
                    .px(px(14.))
                    .py(px(8.))
                    .rounded(px(6.))
                    .bg(c.well)
                    .font_features(theme::tabular())
                    .text_size(px(ui::TITLE))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(code),
            );
        }
        if let Some(link) = sign_in.link {
            let (open, copy) = (link.clone(), link.clone());
            body = body
                .child(caption(link, c).truncate())
                .child(
                    h_flex()
                        .gap(px(8.))
                        .child(push("open-link", "Open again").on_click(move |_, _, cx| {
                            cx.open_url(&open);
                        }))
                        .child(push("copy-link", "Copy link").on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                        })),
                )
                .child(
                    h_flex()
                        .gap(px(8.))
                        .child(div().flex_1().child(field(&self.paste)))
                        .child(push("paste", "Use address").on_click(move |_, window, cx| {
                            let address = paste.read(cx).value().to_string();
                            app.paste(address);
                            paste.update(cx, |input, cx| input.set_value("", window, cx));
                        })),
                );
        }
        if !sign_in.notes.is_empty() {
            body = body.child(
                h_flex()
                    .gap(px(8.))
                    .text_size(px(ui::SMALL))
                    .text_color(c.warn)
                    .child(dot(c.warn))
                    .child(sign_in.notes),
            );
        }
        Some(body)
    }
}

impl Render for Main {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Colors::of(cx);
        let now = Timestamp::now();
        let page = match self.section {
            Section::Overview => self.overview(&c, now, cx).into_any_element(),
            Section::Provider(provider) => self.provider(provider, &c, now, cx).into_any_element(),
            Section::Usage => self.usage(&c, false).into_any_element(),
            Section::Performance => self.usage(&c, true).into_any_element(),
            Section::Agents => self.agents(&c).into_any_element(),
            Section::Access => self.access(&c, cx).into_any_element(),
            Section::Diagnostics => self.diagnostics(&c).into_any_element(),
            Section::Settings => self.settings(&c, cx).into_any_element(),
        };
        let _ = window;
        let sidebar = self.sidebar;
        // The sidebar keeps its width as it slides, its pane clipping it.
        let pane = div()
            .id("sidebar")
            .h_full()
            .flex_shrink_0()
            .overflow_hidden()
            .child(self.sidebar(&c, now, cx).w(px(sidebar.width)));
        let pane = if let Some(slide) = sidebar.slide {
            let slide = Animation::new(slide.length).with_easing(motion::ease_in_out);
            pane.with_animation(("slide", sidebar.slides), slide, move |pane, along| {
                pane.w(px(sidebar.open(along)))
            })
            .into_any_element()
        } else {
            pane.w(px(sidebar.open(1.))).into_any_element()
        };
        h_flex()
            .relative()
            .size_full()
            .bg(c.bg)
            .text_color(c.fg)
            .on_action(cx.listener(|main, _: &ToggleSidebar, _, cx| {
                main.toggle_sidebar(false, cx);
            }))
            // A drag of the sidebar's edge follows the pointer anywhere in
            // the window.
            .on_mouse_move(cx.listener(|main, event: &MouseMoveEvent, _, cx| {
                main.drag_sidebar(event, cx);
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|main, _, _, cx| main.end_drag(cx)),
            )
            .when(sidebar.dragging, |root| root.cursor_col_resize())
            .child(pane)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(
                        self.header(&c, cx)
                            .pl(px(if sidebar.hidden { LEAD } else { MARGIN })),
                    )
                    .child(
                        div().flex_1().min_h_0().child(
                            v_flex()
                                .id("body")
                                .size_full()
                                .px(px(MARGIN))
                                .pt(px(4.))
                                .pb(px(40.))
                                .gap(px(32.))
                                .overflow_y_scrollbar()
                                .children(self.sign_in(&c))
                                // Every page as wide, up to a width that
                                // keeps a row's ends within a glance.
                                .child(v_flex().w_full().max_w(px(CONTENT)).child(page)),
                        ),
                    ),
            )
            // The sidebar's edge, to drag.
            .when(!sidebar.hidden, |root| {
                root.child(
                    div()
                        .id("sidebar-edge")
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(sidebar.width - 3.))
                        .w(px(6.))
                        .cursor_col_resize()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|main, _, _, cx| {
                                main.sidebar.dragging = true;
                                main.sidebar.dragged_from = main.sidebar.width;
                                main.sidebar.slide = None;
                                cx.stop_propagation();
                                cx.notify();
                            }),
                        ),
                )
            })
            .children(self.notice(&c))
    }
}

/// A group's title in the sidebar.
fn sidebar_heading(title: &str, c: &Colors) -> Div {
    div()
        .px(px(10.))
        .pt(px(16.))
        .pb(px(4.))
        .text_size(px(ui::SMALL))
        .font_weight(FontWeight::MEDIUM)
        .text_color(c.faint)
        .child(title.to_string())
}

#[cfg(test)]
mod tests {
    // Not the glob, which brings GPUI's own `test` attribute.
    use std::time::Instant;

    use super::{SIDEBAR, Sidebar};

    fn shown() -> Sidebar {
        Sidebar {
            width: SIDEBAR,
            hidden: false,
            slides: 0,
            slide: None,
            dragging: false,
            dragged_from: SIDEBAR,
        }
    }

    #[test]
    fn a_slide_runs_from_where_it_set_out_to_where_it_rests() {
        let mut sidebar = shown();
        sidebar.toggle(true);
        assert!(sidebar.hidden);
        assert_eq!(sidebar.open(0.), SIDEBAR);
        assert_eq!(sidebar.open(1.), 0.);
    }

    #[test]
    fn a_slide_turned_back_sets_out_from_where_it_had_reached() {
        let mut sidebar = shown();
        sidebar.toggle(true);
        let hiding = sidebar.slide.expect("a press slides it");
        // Halfway through hiding, in time.
        if let Some(slide) = sidebar.slide.as_mut() {
            slide.started = Instant::now() - hiding.length / 2;
        }
        let reached = sidebar.shown();
        assert!(0. < reached && reached < 1.);
        sidebar.toggle(true);
        assert!(!sidebar.hidden);
        assert!((sidebar.open(0.) - SIDEBAR * reached).abs() < 1.);
        assert_eq!(sidebar.open(1.), SIDEBAR);
        // With less of the way to go, it takes less time.
        assert!(sidebar.slide.expect("a press slides it").length < hiding.length);
    }

    #[test]
    fn the_keyboard_shows_and_hides_it_at_once() {
        let mut sidebar = shown();
        sidebar.toggle(false);
        assert!(sidebar.slide.is_none());
        assert_eq!(sidebar.open(0.), 0.);
    }
}
