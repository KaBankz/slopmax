//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar item whose panel shows each pool at a glance.
//!
//! It dresses and behaves as a Mac app: a sidebar on the system's material
//! that slides away and back (⌃⌘S, or its toolbar button), resizes by its
//! edge, collapses when dragged narrow, and remembers how it was left;
//! selection on a press, and the arrow keys, as a source list has them;
//! SF Symbols; glass toolbar controls; the system's appearance and accent
//! color; AppKit's colors, type sizes, and control heights; and the
//! standard menus and shortcuts.

mod accounts;
mod native;
mod overview;
mod panel;
mod settings;
mod symbols;
mod usage;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::button::Button;
use gpui_kit::component::input::{self, Input, InputState};
use gpui_kit::component::native_menu::NativeMenu;
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme, Sizable, Theme, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_tray::{Icon, Tray};
use slopmax_app::history::Range;
use slopmax_app::view::{self, Label};
use slopmax_app::{App as Slopmax, Proxy, Snapshot};
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

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

/// The toolbar's height, a Mac toolbar's.
const TOOLBAR: Pixels = px(52.);
/// The sidebar's width at first, and the least and most a drag of its edge
/// leaves it.
const SIDEBAR: f32 = 220.;
const SIDEBAR_MIN: f32 = 180.;
const SIDEBAR_MAX: f32 = 320.;
/// Dragged narrower than this, the sidebar hides, as a split view's does.
const SIDEBAR_COLLAPSE: f32 = 120.;
/// How long the sidebar takes to slide in or out.
const SLIDE: Duration = Duration::from_millis(250);
/// Where the sidebar's toggle sits, past the window's buttons, whether the
/// sidebar shows or not.
const TOGGLE_X: f32 = 90.;
/// How often the charts reread the ledger while they show.
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
            Self::Settings => "Settings",
        }
    }

    /// Its SF Symbol in the sidebar; a provider shows its color instead.
    fn symbol(self) -> &'static str {
        match self {
            Self::Overview => "gauge.with.dots.needle.50percent",
            Self::Provider(_) => "person.2",
            Self::Usage => "chart.bar.xaxis",
            Self::Performance => "bolt.horizontal",
            Self::Agents => "powerplug",
            Self::Settings => "gearshape",
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
    let app = Arc::new(Slopmax::start()?);
    // Closing the window leaves the menu bar item, whose panel quits the
    // app; clicking the Dock icon opens the window again.
    let application = gpui_kit::application().with_quit_mode(QuitMode::Explicit);
    application.on_reopen(open_window);
    application.run(move |cx| {
        gpui_kit::init(cx);
        cx.on_action(|_: &OpenWindow, cx| open_window(cx));
        cx.on_action(|_: &OpenSettings, cx| show(Section::Settings, cx));
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
        menus(cx, false);
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
    });
    Ok(())
}

/// The usual shortcuts, and the sidebar's arrow keys.
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

/// The menus every Mac app has. Edit's items reach the focused text field;
/// View's first item says what it will do to the sidebar.
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
        // AppKit fills a menu named Window with the open windows.
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
    // app sets the item's image itself; elsewhere the tray takes the icon.
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
            // Centered in the toolbar's height, at the sidebar's top.
            traffic_light_position: Some(point(px(20.), px(19.))),
            ..TitleBar::title_bar_options()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1080.), px(760.)),
            cx,
        ))),
        window_min_size: Some(size(px(860.), px(520.))),
        // The sidebar shows the material behind; the page paints its own.
        window_background: WindowBackgroundAppearance::Transparent,
        ..TitleBar::window_options()
    };
    match gpui_kit::open_window(options, cx, |window, cx| {
        macos_theme(window, cx);
        cx.new(|cx| Main::new(app, window, cx))
    }) {
        Ok((window, main)) => {
            clear_root(window, cx);
            let shared = cx.global_mut::<Shared>();
            shared.window = Some(window);
            shared.main = Some(main.downgrade());
        }
        Err(e) => eprintln!("slopmax: could not open the window: {e:#}"),
    }
    cx.activate(true);
}

/// Lets the material `native` puts behind `window` show wherever the view
/// paints nothing, as gpui-kit's root otherwise fills the window with the
/// theme's background.
fn clear_root(window: AnyWindowHandle, cx: &mut App) {
    let _ = window.update(cx, |_, window, cx| {
        base::Root::update(window, cx, |root, _, cx| {
            root.style()
                .refine(&StyleRefinement::default().bg(transparent_black()));
            cx.notify();
        });
    });
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

/// Dresses gpui-kit's theme as macOS: AppKit's colors for the window's light
/// or dark appearance, as macOS 26 and later draw them (the page, its
/// toolbar and their hairline as a split view's content has them), the
/// accent color chosen in System Settings, and the system's 13-point type,
/// which also brings the controls down to AppKit's heights.
fn macos_theme(window: &mut Window, cx: &mut App) {
    Theme::change(window.appearance(), Some(window), cx);
    let accent = native::system_accent().unwrap_or_else(|| rgb(0x007aff).into());
    Theme::update(cx, |theme| {
        let dark = theme.is_dark();
        let pick =
            |light: u32, dark_: u32| -> Hsla { rgba(if dark { dark_ } else { light }).into() };
        theme.font_size = px(13.);
        theme.radius = px(6.);
        theme.radius_lg = px(10.);
        theme.shadow = false;

        let c = &mut theme.colors;
        c.background = pick(0xffffffff, 0x1b1b1bff);
        c.foreground = pick(0x000000d8, 0xffffffd8);
        c.muted_foreground = pick(0x0000007f, 0xffffff8c);
        c.border = pick(0x00000019, 0xffffff19);
        c.muted = pick(0x00000014, 0xffffff19);
        c.group_box = pick(0x0000000a, 0xffffff08);
        c.group_box_foreground = c.foreground;
        c.title_bar = pick(0xffffffff, 0x232323ff);
        c.title_bar_border = pick(0xe5e5e5ff, 0x2b2b2bff);
        c.popover = pick(0xffffffff, 0x2c2c2cff);
        c.popover_foreground = c.foreground;
        c.input = pick(0x0000001f, 0xffffff1c);
        c.accent = pick(0x0000000a, 0xffffff14);
        c.accent_foreground = c.foreground;

        c.button = pick(0x00000010, 0xffffff1b);
        c.button_hover = pick(0x00000018, 0xffffff24);
        c.button_active = pick(0x00000024, 0xffffff30);
        c.button_foreground = c.foreground;
        c.secondary = c.button;
        c.secondary_hover = c.button_hover;
        c.secondary_active = c.button_active;
        c.secondary_foreground = c.foreground;

        let (hover, active) = (shade(accent, 0.05), shade(accent, -0.06));
        c.primary = accent;
        c.primary_hover = hover;
        c.primary_active = active;
        c.primary_foreground = white();
        c.button_primary = accent;
        c.button_primary_hover = hover;
        c.button_primary_active = active;
        c.button_primary_foreground = white();
        c.ring = accent.opacity(0.5);
        c.selection = accent.opacity(0.3);
        c.caret = accent;
        c.link = pick(0x0068daff, 0x419cffff);

        c.switch = pick(0x00000014, 0xffffff1f);
        c.switch_thumb = pick(0xffffffff, 0xe8e8e8ff);
        c.success = pick(0x34c759ff, 0x30d158ff);
        c.warning = pick(0xff8d28ff, 0xff9230ff);
        c.danger = pick(0xff383cff, 0xff4245ff);
        c.chart_grid = c.border;
    });
}

/// `color`, lighter by `by` (darker when negative).
fn shade(color: Hsla, by: f32) -> Hsla {
    Hsla {
        l: (color.l + by).clamp(0., 1.),
        ..color
    }
}

struct Main {
    app: Arc<Slopmax>,
    snapshot: Snapshot,
    section: Section,
    key: Entity<InputState>,
    key_provider: ProviderId,
    paste: Entity<InputState>,
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
    /// The material AppKit puts behind a sidebar, behind GPUI's.
    backdrop: Option<native::Backdrop>,
    /// The sidebar's list, which the arrow keys move through while it has
    /// focus, its selection then drawn in the accent color.
    sidebar_focus: FocusHandle,
    _tasks: [Task<()>; 2],
    _system: [Subscription; 2],
}

/// The sidebar as the user leaves it, which the window remembers as a split
/// view does: its width, whether it hides, and how it last changed.
#[derive(Debug, Clone, Copy)]
struct Sidebar {
    width: f32,
    hidden: bool,
    /// The slides so far, so that each plays afresh.
    slides: usize,
    /// Whether the latest change slides it: a toggle does; a drag hides it
    /// at once.
    sliding: bool,
    /// A drag of its edge in progress, and the width it began at, which a
    /// drag that hides the sidebar leaves it to come back at.
    dragging: bool,
    dragged_from: f32,
}

impl Sidebar {
    fn recall() -> Self {
        Self {
            width: native::recall("SidebarWidth").map_or(SIDEBAR, |width| {
                (width as f32).clamp(SIDEBAR_MIN, SIDEBAR_MAX)
            }),
            hidden: native::recall("SidebarHidden").is_some_and(|hidden| hidden != 0.),
            slides: 0,
            sliding: false,
            dragging: false,
            dragged_from: SIDEBAR,
        }
    }

    fn remember(self) {
        native::remember("SidebarWidth", f64::from(self.width));
        native::remember("SidebarHidden", if self.hidden { 1. } else { 0. });
    }

    /// How wide it shows `along` a slide, from 0 to 1.
    fn open(self, along: f32) -> f32 {
        let shown = if self.sliding {
            if self.hidden { 1. - along } else { along }
        } else if self.hidden {
            0.
        } else {
            1.
        };
        self.width * shown
    }
}

impl Main {
    fn new(app: Arc<Slopmax>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let key = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("API key")
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
        // The window turns light or dark with the system, and takes up a new
        // accent color when it comes forward from System Settings.
        let appearance =
            cx.observe_window_appearance(window, |_, window, cx| macos_theme(window, cx));
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if window.is_window_active() {
                macos_theme(window, cx);
                panel::dismiss(cx);
            }
        });
        let sidebar = Sidebar::recall();
        menus(cx, sidebar.hidden);
        // The sidebar has focus to begin with, as a source list does.
        let sidebar_focus = cx.focus_handle();
        window.focus(&sidebar_focus, cx);
        let mut main = Self {
            snapshot: app.snapshot(),
            app,
            section: Section::Overview,
            key,
            key_provider: ProviderId::Anthropic,
            paste,
            range: Range::default(),
            asked: None,
            asked_today: None,
            credits_open: HashSet::new(),
            confirming: None,
            backdrop: native::Backdrop::new(window, sidebar.width),
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
                Section::Settings,
            ])
            .collect()
    }

    /// Moves the selection `by` pages, as an arrow key does in a source list.
    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let sections = self.sections(Timestamp::now());
        let at = sections
            .iter()
            .position(|s| *s == self.section)
            .unwrap_or(0);
        let next = at.saturating_add_signed(by).min(sections.len() - 1);
        self.go(sections[next], cx);
    }

    /// Slides the sidebar away, or back.
    fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar.hidden = !self.sidebar.hidden;
        self.sidebar.slides += 1;
        self.sidebar.sliding = true;
        self.sidebar.remember();
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
            self.sidebar.sliding = false;
            self.sidebar.remember();
            menus(cx, true);
        } else {
            self.sidebar.width = x.clamp(SIDEBAR_MIN, SIDEBAR_MAX);
        }
        if let Some(backdrop) = &self.backdrop {
            backdrop.set_width(self.sidebar.width);
        }
        cx.notify();
    }

    fn end_drag(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.dragging {
            self.sidebar.dragging = false;
            self.sidebar.remember();
            cx.notify();
        }
    }

    /// A Mac segmented control as macOS 26 draws one: a capsule, the chosen
    /// segment raised within it; `choose` takes a press.
    fn segmented<T: Copy + PartialEq + 'static>(
        &self,
        id: &str,
        options: impl IntoIterator<Item = (T, &'static str)>,
        chosen: T,
        choose: fn(&mut Self, T, &mut Context<Self>),
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut track = h_flex()
            .flex_shrink_0()
            .h(px(30.))
            .p(px(2.))
            .rounded_full()
            .bg(c.glass)
            .border_1()
            .border_color(c.glass_edge);
        for (i, (value, title)) in options.into_iter().enumerate() {
            let selected = value == chosen;
            track = track.child(
                div()
                    .id(SharedString::from(format!("{id}-{i}")))
                    .h_full()
                    .px(px(11.))
                    .flex()
                    .items_center()
                    .rounded_full()
                    .role(Role::RadioButton)
                    .aria_label(title)
                    .aria_selected(selected)
                    .map(|segment| {
                        if selected {
                            segment.bg(c.raised).shadow_xs()
                        } else {
                            segment.text_color(c.fg.opacity(0.8))
                        }
                    })
                    .child(title)
                    .on_click(cx.listener(move |main, _, _, cx| choose(main, value, cx))),
            );
        }
        track
    }

    /// The sidebar, as a source list: the pages in groups, the providers
    /// among them, under the window's buttons. The window's material shows
    /// through it.
    fn sidebar(&self, c: &Colors, now: Timestamp, emphasized: bool, cx: &mut Context<Self>) -> Div {
        let report = self.snapshot.report.as_ref();
        let groups = report.map(|r| view::groups(r, now)).unwrap_or_default();
        let attention = report.map(|r| view::attention(r, now)).unwrap_or_default();
        let mut list = v_flex()
            .id("sidebar-list")
            .size_full()
            .px(px(10.))
            .pb(px(12.))
            .overflow_y_scroll()
            .track_focus(&self.sidebar_focus)
            .key_context("Sidebar")
            .on_action(cx.listener(|main, _: &SelectPrevious, _, cx| main.step(-1, cx)))
            .on_action(cx.listener(|main, _: &SelectNext, _, cx| main.step(1, cx)))
            .role(Role::List)
            .aria_label("Sidebar")
            .child(self.item(Section::Overview, None, None, emphasized, c, cx))
            .child(sidebar_heading("Accounts", c));
        if groups.is_empty() {
            list = list.child(
                div()
                    .px(px(10.))
                    .h(px(32.))
                    .flex()
                    .items_center()
                    .text_color(c.muted)
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
                .max_by_key(|tone| *tone == Tone::Bad);
            let trailing = match alert {
                Some(tone) => dot(c.tone(tone)).into_any_element(),
                None => div()
                    .text_size(px(12.))
                    .text_color(c.muted)
                    .child(group.accounts.len().to_string())
                    .into_any_element(),
            };
            list = list.child(self.item(
                Section::Provider(group.provider),
                Some(provider_color(group.provider, c)),
                Some(trailing),
                emphasized,
                c,
                cx,
            ));
        }
        list = list
            .child(sidebar_heading("Activity", c))
            .child(self.item(Section::Usage, None, None, emphasized, c, cx))
            .child(self.item(Section::Performance, None, None, emphasized, c, cx))
            .child(sidebar_heading("Setup", c))
            .child(self.item(Section::Agents, None, None, emphasized, c, cx))
            .child(self.item(Section::Settings, None, None, emphasized, c, cx));
        v_flex()
            .h_full()
            // Where the window's buttons sit, and a handle to drag it by.
            .child(
                TitleBar::new()
                    .h(TOOLBAR)
                    .bg(transparent_black())
                    .border_0(),
            )
            .child(div().flex_1().min_h_0().child(list))
    }

    /// A row of the sidebar: its symbol, or a provider's color, its title,
    /// and what trails it. A press selects it, as in a source list; the
    /// selection takes the accent color while the sidebar has focus, and a
    /// quiet gray otherwise.
    fn item(
        &self,
        section: Section,
        color: Option<Hsla>,
        trailing: Option<AnyElement>,
        emphasized: bool,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.section == section;
        let lit = selected && emphasized;
        let ink = if lit { white() } else { c.fg };
        let slot = div()
            .size(px(20.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center();
        let icon = match color {
            Some(color) => slot.child(div().size(px(9.)).rounded_full().bg(color)),
            None => slot.children(symbols::symbol(
                section.symbol(),
                if lit { white() } else { c.muted },
                16.,
                cx,
            )),
        };
        h_flex()
            .id(SharedString::from(format!("go-{section:?}")))
            .h(px(32.))
            .px(px(8.))
            .gap(px(7.))
            .rounded(px(10.))
            .text_color(ink)
            .when(selected, |row| {
                row.bg(if emphasized {
                    c.accent
                } else {
                    c.fg.opacity(0.1)
                })
            })
            .role(Role::ListItem)
            .aria_label(section.title())
            .aria_selected(selected)
            .child(icon)
            .child(div().flex_1().min_w_0().truncate().child(section.title()))
            .children(trailing.map(|trailing| {
                div()
                    .when(lit, |trailing| trailing.text_color(white().opacity(0.8)))
                    .child(trailing)
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |main, _, window, cx| {
                    window.focus(&main.sidebar_focus, cx);
                    main.go(section, cx);
                }),
            )
            // What VoiceOver presses.
            .on_click(cx.listener(move |main, _, _, cx| main.go(section, cx)))
    }

    /// The page's toolbar: its title, and what acts on it, as glass
    /// controls. Its leading padding keeps clear of the window's buttons
    /// and the sidebar's toggle while the sidebar is narrower than them.
    fn toolbar(&self, c: &Colors, cx: &mut Context<Self>) -> TitleBar {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let tools = h_flex()
            .gap(px(8.))
            // A press on a control is a click, never a window drag.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
        let tools = match self.section {
            Section::Overview | Section::Provider(_) => {
                let app = self.app.clone();
                tools
                    .child(
                        tool("add", "plus", c, cx)
                            .tooltip(|window, cx| Tooltip::new("Add an account").build(window, cx))
                            .on_click(|event, window, cx| {
                                // Under the button, as a toolbar's menus open.
                                let at = point(event.position().x - px(14.), TOOLBAR - px(6.));
                                NativeMenu::new()
                                    .menu("Sign In with Claude…", Box::new(SignInClaude))
                                    .menu("Sign In with ChatGPT…", Box::new(SignInChatGpt))
                                    .separator()
                                    .menu("Import Logins", Box::new(ImportLogins))
                                    .menu("Add an API Key…", Box::new(AddKey))
                                    .show(at, window, cx);
                            }),
                    )
                    .child(
                        tool("refresh", "arrow.clockwise", c, cx)
                            .tooltip(|window, cx| Tooltip::new("Refresh usage").build(window, cx))
                            .when(!running, |button| button.opacity(0.4))
                            .on_click(move |_, _, _| {
                                if running {
                                    app.refresh();
                                }
                            }),
                    )
            }
            Section::Usage | Section::Performance => tools.child(self.segmented(
                "range",
                Range::ALL.map(|range| (range, range.title())),
                self.range,
                |main, range, cx| {
                    main.range = range;
                    main.load_history();
                    cx.notify();
                },
                c,
                cx,
            )),
            Section::Agents | Section::Settings => tools,
        };
        // The title bar draws the hairline beneath it.
        TitleBar::new()
            .h(TOOLBAR)
            .pr(px(12.))
            .bg(c.toolbar)
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.section.title()),
            )
            .child(tools)
    }

    /// The sidebar's toggle, which stays put past the window's buttons
    /// whether the sidebar shows or not.
    fn sidebar_toggle(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let hidden = self.sidebar.hidden;
        div()
            .absolute()
            .left(px(TOGGLE_X))
            .top((TOOLBAR - px(30.)) / 2.)
            .child(
                tool("toggle-sidebar", "sidebar.left", c, cx)
                    .aria_label(if hidden {
                        "Show Sidebar"
                    } else {
                        "Hide Sidebar"
                    })
                    .tooltip(move |window, cx| {
                        Tooltip::new(if hidden {
                            "Show Sidebar"
                        } else {
                            "Hide Sidebar"
                        })
                        .build(window, cx)
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|main, _, _, cx| main.toggle_sidebar(cx))),
            )
    }

    fn notice(&self, c: &Colors) -> Option<impl IntoElement> {
        let notice = self.snapshot.notice.as_ref()?;
        let app = self.app.clone();
        // Floats over the corner, so it never moves what is under the pointer.
        Some(
            h_flex()
                .absolute()
                .right(px(20.))
                .bottom(px(20.))
                .w(px(420.))
                .p(px(12.))
                .gap(px(10.))
                .rounded(px(12.))
                .border_1()
                .border_color(c.separator)
                .bg(c.popover)
                .shadow_lg()
                .child(dot(if notice.error { c.bad } else { c.good }))
                .child(div().flex_1().child(notice.text.clone()))
                .child(
                    push("dismiss", "Dismiss")
                        .small()
                        .on_click(move |_, _, _| app.dismiss_notice()),
                ),
        )
    }

    /// A sign-in in progress: what to do in the browser, or the code to
    /// enter, above whatever page shows.
    fn sign_in(&self, c: &Colors) -> Option<impl IntoElement> {
        let sign_in = view::sign_in(self.snapshot.sign_in.as_ref()?);
        let (app, cancel) = (self.app.clone(), self.app.clone());
        let paste = self.paste.clone();
        let mut body = group_box(c).py(px(12.)).gap(px(10.)).child(sign_in.detail);
        if let Some(code) = sign_in.code {
            body = body.child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::BOLD)
                    .child(code),
            );
        }
        if let Some(link) = sign_in.link {
            let (open, copy) = (link.clone(), link.clone());
            body = body
                .child(div().text_size(px(11.)).text_color(c.muted).child(link))
                .child(
                    h_flex()
                        .gap(px(8.))
                        .child(
                            push("open-link", "Open again")
                                .on_click(move |_, _, cx| cx.open_url(&open)),
                        )
                        .child(push("copy-link", "Copy").on_click(move |_, _, cx| {
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
            body = body.child(h_flex().gap(px(6.)).child(dot(c.warn)).child(sign_in.notes));
        }
        Some(section(&sign_in.title, c).child(body.child(h_flex().child(
            push("cancel-sign-in", "Cancel").on_click(move |_, _, _| cancel.cancel_sign_in()),
        ))))
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
            Section::Settings => self.settings(&c, cx).into_any_element(),
        };
        let sidebar = self.sidebar;
        let emphasized = self.sidebar_focus.is_focused(window) && window.is_window_active();
        // The sidebar keeps its width as it slides, its pane clipping it.
        let pane = div()
            .id("sidebar")
            .h_full()
            .flex_shrink_0()
            .overflow_hidden()
            .child(self.sidebar(&c, now, emphasized, cx).w(px(sidebar.width)));
        let toolbar = self.toolbar(&c, cx);
        let (pane, toolbar) = if sidebar.sliding {
            let slide = || Animation::new(SLIDE).with_easing(ease_in_out);
            (
                pane.with_animation(("slide", sidebar.slides), slide(), move |pane, along| {
                    pane.w(px(sidebar.open(along)))
                })
                .into_any_element(),
                toolbar
                    .with_animation(("clear", sidebar.slides), slide(), move |bar, along| {
                        bar.pl(px(clear(sidebar.open(along))))
                    })
                    .into_any_element(),
            )
        } else {
            (
                pane.w(px(sidebar.open(1.))).into_any_element(),
                toolbar.pl(px(clear(sidebar.open(1.)))).into_any_element(),
            )
        };
        h_flex()
            .relative()
            .size_full()
            .text_color(c.fg)
            .on_action(cx.listener(|main, _: &AddKey, _, cx| main.go(Section::Settings, cx)))
            .on_action(cx.listener(|main, _: &ToggleSidebar, _, cx| main.toggle_sidebar(cx)))
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
                    .bg(c.bg)
                    .child(toolbar)
                    .child(
                        div().flex_1().min_h_0().child(
                            v_flex()
                                .id("body")
                                .size_full()
                                .px(px(28.))
                                .pt(px(14.))
                                .pb(px(28.))
                                .gap(px(26.))
                                .overflow_y_scrollbar()
                                .children(self.sign_in(&c))
                                .child(page),
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
                                main.sidebar.sliding = false;
                                cx.stop_propagation();
                                cx.notify();
                            }),
                        ),
                )
            })
            .child(self.sidebar_toggle(&c, cx))
            .children(self.notice(&c))
    }
}

/// The toolbar's leading padding while the sidebar shows `open` points of
/// itself: clear of the window's buttons and the sidebar's toggle.
fn clear(open: f32) -> f32 {
    (TOGGLE_X + 30. + 18. - open).max(20.)
}

/// The theme's colors this window uses, read once per frame.
#[derive(Clone, Copy)]
struct Colors {
    bg: Hsla,
    toolbar: Hsla,
    fg: Hsla,
    muted: Hsla,
    separator: Hsla,
    group: Hsla,
    track: Hsla,
    popover: Hsla,
    good: Hsla,
    warn: Hsla,
    bad: Hsla,
    accent: Hsla,
    /// A toolbar control's glass, its edge, and a segment raised in it.
    glass: Hsla,
    glass_edge: Hsla,
    raised: Hsla,
}

impl Colors {
    fn of(cx: &App) -> Self {
        let theme = cx.theme();
        Self {
            bg: theme.background,
            toolbar: theme.title_bar,
            fg: theme.foreground,
            muted: theme.muted_foreground,
            separator: theme.border,
            group: theme.group_box,
            track: theme.muted,
            popover: theme.popover,
            good: theme.success,
            warn: theme.warning,
            bad: theme.danger,
            accent: theme.primary,
            glass: theme.foreground.opacity(0.07),
            glass_edge: theme.foreground.opacity(0.09),
            raised: if theme.is_dark() {
                rgba(0xffffff2e).into()
            } else {
                white()
            },
        }
    }

    fn tone(&self, tone: Tone) -> Hsla {
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
    fn gauge(&self, tone: Tone, provider: ProviderId) -> Hsla {
        match tone {
            Tone::Good | Tone::Muted | Tone::Accent => provider_color(provider, self),
            tone => self.tone(tone),
        }
    }
}

/// A provider's color, on every page and chart: its brand's.
fn provider_color(provider: ProviderId, c: &Colors) -> Hsla {
    match provider {
        ProviderId::Claude | ProviderId::Anthropic => rgb(0xd97757).into(),
        ProviderId::Codex | ProviderId::OpenAI => rgb(0x10a37f).into(),
        ProviderId::Xai => c.muted,
        _ => c.accent,
    }
}

/// A Mac push button: a gray rounded rectangle without a border.
fn push(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    Button::new(id).label(label).border_0()
}

/// A toolbar button as macOS 26 draws one: a glass capsule holding an SF
/// Symbol.
fn tool(id: &'static str, symbol: &'static str, c: &Colors, cx: &mut App) -> Stateful<Div> {
    let (hover, pressed) = (c.fg.opacity(0.12), c.fg.opacity(0.18));
    div()
        .id(id)
        .h(px(30.))
        .min_w(px(36.))
        .px(px(9.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(c.glass)
        .border_1()
        .border_color(c.glass_edge)
        .hover(move |button| button.bg(hover))
        .active(move |button| button.bg(pressed))
        .role(Role::Button)
        .children(symbols::symbol(symbol, c.fg.opacity(0.8), 15., cx))
}

/// A Mac text field: 13-point text, with room for it at a control's height.
fn field(state: &Entity<InputState>) -> Input {
    Input::new(state).py(px(3.)).text_size(px(13.))
}

/// A part of a page as System Settings draws one: a heading over its
/// content.
fn section(title: &str, c: &Colors) -> Div {
    v_flex().gap(px(8.)).child(heading(title, c))
}

fn heading(text: &str, c: &Colors) -> Div {
    div()
        .px(px(4.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.fg)
        .child(text.to_string())
}

/// A group's title in the sidebar.
fn sidebar_heading(title: &str, c: &Colors) -> Div {
    div()
        .px(px(8.))
        .pt(px(14.))
        .pb(px(4.))
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.muted)
        .child(title.to_string())
}

/// Rows grouped on a faint, rounded fill.
fn group_box(c: &Colors) -> Div {
    v_flex().px(px(12.)).rounded(px(10.)).bg(c.group)
}

fn caption(text: &str, c: &Colors) -> Div {
    div()
        .text_size(px(11.))
        .text_color(c.muted)
        .child(text.to_string())
}

fn dot(color: Hsla) -> Div {
    div().flex_shrink_0().size(px(7.)).rounded_full().bg(color)
}

/// A worded state. Good, warning, and bad ones lead with a dot of their
/// color, as Mac apps show status, and keep their words readable.
fn label(label: &Label, c: &Colors) -> Div {
    let text = div().min_w_0().truncate().child(label.text.clone());
    let line = h_flex().min_w_0().gap(px(6.));
    match label.tone {
        Tone::Muted | Tone::Accent => line.text_color(c.tone(label.tone)).child(text),
        tone => line.child(dot(c.tone(tone))).child(text),
    }
}

/// A gauge's bar, filled to `fraction`.
fn bar(fraction: f32, color: Hsla, c: &Colors) -> Div {
    div().h(px(5.)).rounded_full().bg(c.track).child(
        div()
            .h_full()
            .w(relative(fraction))
            .rounded_full()
            .bg(color),
    )
}
