//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar item whose panel shows each pool at a glance.
//!
//! It wears slopmax's own design on every system, in gpui-kit's components:
//! its light and dark themes, the Inter typeface, and Lucide's icons. Its
//! sidebar slides away and back (⌃⌘S, or its button), resizes by its edge,
//! hides when dragged narrow, and is left as the user leaves it.

mod accounts;
mod assets;
mod native;
mod overview;
mod panel;
mod prefs;
mod settings;
mod theme;
mod ui;
mod usage;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{self, Input, InputState};
use gpui_kit::component::menu::DropdownMenu as _;
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::{ActiveTheme as _, Disableable, Sizable, TitleBar, h_flex, v_flex};
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
use crate::theme::{Colors, DISPLAY};
use crate::ui::{caption, card, dot, icon, logo, segmented};

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

/// The height of the strip across the window's top: the sidebar's brand and
/// the page's title and tools.
const HEADER: Pixels = px(56.);
/// Where the window's own buttons leave room on a Mac, and elsewhere.
const LEAD: f32 = if cfg!(target_os = "macos") { 84. } else { 16. };
/// The sidebar's width at first, and the least and most a drag of its edge
/// leaves it.
const SIDEBAR: f32 = 236.;
const SIDEBAR_MIN: f32 = 200.;
const SIDEBAR_MAX: f32 = 340.;
/// Dragged narrower than this, the sidebar hides.
const SIDEBAR_COLLAPSE: f32 = 130.;
/// How long the sidebar takes to slide in or out.
const SLIDE: Duration = Duration::from_millis(250);
/// The page's margin from the window's edges.
const MARGIN: f32 = 28.;
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

    /// Its icon in the sidebar; a provider shows its color instead.
    fn icon(self) -> IconName {
        match self {
            Self::Overview => IconName::LayoutDashboard,
            Self::Provider(_) => IconName::Users,
            Self::Usage => IconName::ChartColumn,
            Self::Performance => IconName::Zap,
            Self::Agents => IconName::Bot,
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
    let app = Arc::new(Slopmax::start()?);
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
        cx.on_action(|_: &AddKey, cx| show(Section::Settings, cx));
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
    /// Whether the latest change slides it: a toggle does; a drag hides it
    /// at once.
    sliding: bool,
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
            sliding: false,
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

    /// Slides the sidebar away, or back.
    fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar.hidden = !self.sidebar.hidden;
        self.sidebar.slides += 1;
        self.sidebar.sliding = true;
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
            self.sidebar.sliding = false;
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
            .px(px(10.))
            .pb(px(12.))
            .gap(px(2.))
            .overflow_y_scroll()
            .track_focus(&self.sidebar_focus)
            .key_context("Sidebar")
            .on_action(cx.listener(|main, _: &SelectPrevious, _, cx| main.step(-1, cx)))
            .on_action(cx.listener(|main, _: &SelectNext, _, cx| main.step(1, cx)))
            .role(Role::List)
            .aria_label("Sidebar")
            .child(self.item(Section::Overview, None, None, c, cx))
            .child(sidebar_heading("Accounts", c));
        if groups.is_empty() {
            list = list.child(
                div()
                    .px(px(10.))
                    .h(px(32.))
                    .flex()
                    .items_center()
                    .text_size(px(12.5))
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
                .max_by_key(|tone| *tone == Tone::Bad);
            let trailing = match alert {
                Some(tone) => dot(c.tone(tone)).into_any_element(),
                None => div()
                    .text_size(px(11.5))
                    .text_color(c.faint)
                    .child(group.accounts.len().to_string())
                    .into_any_element(),
            };
            list = list.child(self.item(
                Section::Provider(group.provider),
                Some(c.provider(group.provider)),
                Some(trailing),
                c,
                cx,
            ));
        }
        list = list
            .child(sidebar_heading("Activity", c))
            .child(self.item(Section::Usage, None, None, c, cx))
            .child(self.item(Section::Performance, None, None, c, cx))
            .child(sidebar_heading("Setup", c))
            .child(self.item(Section::Agents, None, None, c, cx))
            .child(self.item(Section::Settings, None, None, c, cx));
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
                    .pr(px(10.))
                    .gap(px(9.))
                    .child(logo(24., c))
                    .child(
                        div()
                            .flex_1()
                            .font_family(DISPLAY)
                            .text_size(px(16.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.fg)
                            .child("slopmax"),
                    )
                    .child(self.sidebar_toggle(true, cx)),
            )
            .child(div().flex_1().min_h_0().child(list))
            .child(self.proxy_status(c, cx))
    }

    /// A row of the sidebar: its icon, or a provider's color, its title,
    /// and what trails it. A press chooses it.
    fn item(
        &self,
        section: Section,
        color: Option<Hsla>,
        trailing: Option<AnyElement>,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.section == section;
        let slot = div()
            .size(px(18.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center();
        let leading = match color {
            Some(color) => slot.child(div().size(px(8.)).rounded_full().bg(color)),
            None => slot.child(icon(
                section.icon(),
                16.,
                if selected { c.accent } else { c.muted },
            )),
        };
        let (hover, fg) = (c.hover, c.fg);
        h_flex()
            .id(SharedString::from(format!("go-{section:?}")))
            .h(px(32.))
            .px(px(10.))
            .gap(px(10.))
            .rounded(px(8.))
            .text_size(px(13.))
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
            Proxy::Running { version } => (format!("Proxy running · {version}"), c.good),
            Proxy::Starting => ("Proxy starting…".to_owned(), c.warn),
            Proxy::Checking => ("Looking for the proxy…".to_owned(), c.muted),
            Proxy::Stopped => ("Proxy stopped".to_owned(), c.bad),
        };
        let (hover, surface) = (c.hover, c.surface);
        div().p(px(10.)).child(
            h_flex()
                .id("proxy-status")
                .gap(px(10.))
                .px(px(10.))
                .py(px(8.))
                .rounded(px(10.))
                .border_1()
                .border_color(c.border)
                .bg(surface)
                .cursor_pointer()
                .hover(move |row| row.bg(hover))
                .role(Role::Button)
                .aria_label(state.clone())
                .child(
                    div()
                        .size(px(8.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(color)
                        .shadow(vec![
                            BoxShadow::new(px(0.), px(0.), color.opacity(0.6)).blur_radius(px(6.)),
                        ]),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(c.fg)
                                .child(state),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(11.))
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
        Button::new(if shown {
            "hide-sidebar"
        } else {
            "show-sidebar"
        })
        .icon(if shown {
            IconName::PanelLeftClose
        } else {
            IconName::PanelLeftOpen
        })
        .ghost()
        .small()
        .tooltip(tip)
        .accessibility_label(tip)
        .on_click(cx.listener(|main, _, _, cx| main.toggle_sidebar(cx)))
    }

    /// The page's header: its title, and what acts on it.
    fn header(&self, c: &Colors, cx: &mut Context<Self>) -> TitleBar {
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
                        Button::new("refresh")
                            .icon(IconName::RefreshCw)
                            .ghost()
                            .small()
                            .tooltip("Refresh usage")
                            .accessibility_label("Refresh usage")
                            .disabled(!running)
                            .on_click(move |_, _, _| app.refresh()),
                    )
                    .child(
                        Button::new("add")
                            .icon(IconName::Plus)
                            .label("Add account")
                            .primary()
                            .small()
                            .dropdown_menu_with_anchor(Anchor::TopRight, |menu, _, _| {
                                menu.menu_with_icon(
                                    "Sign in with Claude…",
                                    IconName::LogIn,
                                    Box::new(SignInClaude),
                                )
                                .menu_with_icon(
                                    "Sign in with ChatGPT…",
                                    IconName::LogIn,
                                    Box::new(SignInChatGpt),
                                )
                                .separator()
                                .menu_with_icon(
                                    "Import logins",
                                    IconName::Download,
                                    Box::new(ImportLogins),
                                )
                                .menu_with_icon(
                                    "Add an API key…",
                                    IconName::KeyRound,
                                    Box::new(AddKey),
                                )
                            }),
                    )
            }
            Section::Usage | Section::Performance => tools.child(segmented(
                "range",
                Range::ALL.map(|range| (range, range.title())),
                self.range,
                |main: &mut Self, range, cx| {
                    main.range = range;
                    main.load_history();
                    cx.notify();
                },
                c,
                cx,
            )),
            Section::Agents | Section::Settings => tools,
        };
        TitleBar::new()
            .h(HEADER)
            .pr(px(16.))
            .bg(c.bg)
            .border_0()
            .child(
                h_flex()
                    .gap(px(10.))
                    .when(self.sidebar.hidden, |title| {
                        title.child(self.sidebar_toggle(false, cx))
                    })
                    .child(
                        div()
                            .font_family(DISPLAY)
                            .text_size(px(ui::TITLE))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.fg)
                            .child(self.section.title()),
                    ),
            )
            .child(tools)
    }

    fn notice(&self, c: &Colors) -> Option<impl IntoElement> {
        let notice = self.snapshot.notice.as_ref()?;
        let app = self.app.clone();
        let (name, color) = if notice.error {
            (IconName::CircleX, c.bad)
        } else {
            (IconName::CircleCheck, c.good)
        };
        // Floats over the corner, so it never moves what is under the pointer.
        Some(
            h_flex()
                .absolute()
                .right(px(20.))
                .bottom(px(20.))
                .w(px(420.))
                .p(px(12.))
                .pl(px(14.))
                .gap(px(12.))
                .rounded(px(12.))
                .border_1()
                .border_color(c.border)
                .bg(c.popover)
                .shadow_lg()
                .child(icon(name, 18., color))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(12.5))
                        .text_color(c.fg)
                        .child(notice.text.clone()),
                )
                .child(
                    Button::new("dismiss")
                        .icon(IconName::Close)
                        .ghost()
                        .xsmall()
                        .tooltip("Dismiss")
                        .accessibility_label("Dismiss")
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
        let mut body = card(c).border_color(c.accent.opacity(0.5)).child(
            h_flex()
                .gap(px(12.))
                .child(ui::icon_tile(IconName::LogIn, c.accent, 32., c))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(ui::HEADING))
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
                    .px(px(16.))
                    .py(px(10.))
                    .rounded(px(10.))
                    .bg(c.well)
                    .font_family(DISPLAY)
                    .text_size(px(26.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(code),
            );
        }
        if let Some(link) = sign_in.link {
            let (open, copy) = (link.clone(), link.clone());
            body = body
                .child(
                    div()
                        .text_size(px(ui::TINY))
                        .text_color(c.muted)
                        .truncate()
                        .child(link),
                )
                .child(
                    h_flex()
                        .gap(px(8.))
                        .child(
                            push("open-link", "Open again")
                                .icon(IconName::ExternalLink)
                                .on_click(move |_, _, cx| cx.open_url(&open)),
                        )
                        .child(
                            push("copy-link", "Copy link")
                                .icon(IconName::Copy)
                                .on_click(move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                                }),
                        ),
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
                    .child(icon(IconName::TriangleAlert, 14., c.warn))
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
        let pane = if sidebar.sliding {
            let slide = Animation::new(SLIDE).with_easing(ease_in_out);
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
                                .pt(px(6.))
                                .pb(px(32.))
                                .gap(px(24.))
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
            .children(self.notice(&c))
    }
}

/// A button for a secondary action.
fn push(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    Button::new(id).label(label).small()
}

/// A text field.
fn field(state: &Entity<InputState>) -> Input {
    Input::new(state).small()
}

/// A group's title in the sidebar.
fn sidebar_heading(title: &str, c: &Colors) -> Div {
    div()
        .px(px(10.))
        .pt(px(18.))
        .pb(px(6.))
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.faint)
        .child(title.to_string())
}
