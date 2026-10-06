//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar icon showing each pool's use.
//!
//! It dresses as a Mac app: a sidebar on the system's material between its
//! pages, SF Symbols, the system's appearance and accent color, AppKit's
//! colors, type sizes, and control heights, and the standard menus and
//! shortcuts.

mod accounts;
mod native;
mod overview;
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
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, Theme, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_tray::{Icon, Tray};
use slopmax_app::history::Range;
use slopmax_app::view::{self, Label};
use slopmax_app::{App as Slopmax, Proxy, Snapshot};
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::native::Material;

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
        OpenSettings
    ]
);

const TRAY_ICON: &[u8] = include_bytes!("../../../assets/tray.svg");

/// The API-key providers, in the order the key row offers them.
const KEYS: [ProviderId; 3] = [ProviderId::Anthropic, ProviderId::OpenAI, ProviderId::Xai];

/// The toolbar's height, a Mac toolbar's.
const TOOLBAR: Pixels = px(52.);
/// The sidebar's width.
const SIDEBAR: Pixels = px(216.);
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
}

impl Global for Shared {}

fn main() -> anyhow::Result<()> {
    let app = Arc::new(Slopmax::start()?);
    // Closing the window leaves the menu bar icon, whose Quit ends the app;
    // clicking the Dock icon opens the window again.
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
        menus(cx);
        let tray = menu_bar_icon(cx)
            .inspect_err(|e| eprintln!("slopmax: no menu bar icon: {e}"))
            .ok();
        cx.set_global(Shared {
            app,
            tray,
            window: None,
            main: None,
        });
        open_window(cx);
    });
    Ok(())
}

/// The menus every Mac app has, with their usual shortcuts. Edit's items
/// reach the focused text field.
fn menus(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-r", Refresh, None),
        KeyBinding::new("cmd-o", OpenWindow, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
    ]);
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
        Menu::new("View").items([MenuItem::action("Refresh Usage", Refresh)]),
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

fn menu_bar_icon(cx: &mut App) -> gpui_tray::Result<Tray> {
    let tray = Tray::builder()
        .title("slopmax")
        .tooltip("slopmax")
        .menu(|_| {
            vec![
                MenuItem::action("Open slopmax", OpenWindow),
                MenuItem::action("Refresh Usage", Refresh),
                MenuItem::separator(),
                MenuItem::action("Quit slopmax", Quit),
            ]
        });
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
        native::frost(window, Material::Sidebar, 0.);
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

/// Dresses gpui-kit's theme as macOS: AppKit's colors for the window's light
/// or dark appearance, as macOS 26 and later draw them, the accent color
/// chosen in System Settings, and the system's 13-point type, which also
/// brings the controls down to AppKit's heights.
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
        c.background = pick(0xffffffff, 0x1e1e1eff);
        c.foreground = pick(0x000000d8, 0xffffffd8);
        c.muted_foreground = pick(0x0000007f, 0xffffff8c);
        c.border = pick(0x00000019, 0xffffff19);
        c.muted = pick(0x00000014, 0xffffff19);
        c.group_box = pick(0x0000000a, 0xffffff0d);
        c.group_box_foreground = c.foreground;
        c.title_bar = c.background;
        c.title_bar_border = c.border;
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
    _tasks: [Task<()>; 2],
    _system: [Subscription; 2],
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
            }
        });
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
        self.section = section;
        match section {
            Section::Usage | Section::Performance => self.load_history(),
            Section::Overview => self.load_today(),
            _ => {}
        }
        cx.notify();
    }

    /// A Mac segmented control, the chosen segment filled with the accent
    /// color; `choose` takes a press.
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
            .h(rems(2.))
            .rounded(px(6.))
            .bg(c.control);
        let mut after_chosen = true;
        for (i, (value, title)) in options.into_iter().enumerate() {
            let selected = value == chosen;
            // Unchosen neighbors are divided by a short rule.
            if !selected && !after_chosen {
                track = track.child(div().w(px(1.)).h(px(12.)).bg(c.fg.opacity(0.3)));
            }
            after_chosen = selected;
            track = track.child(
                div()
                    .id(SharedString::from(format!("{id}-{i}")))
                    .h_full()
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .role(Role::RadioButton)
                    .aria_label(title)
                    .aria_selected(selected)
                    .when(selected, |segment| segment.bg(c.accent).text_color(white()))
                    .child(title)
                    .on_click(cx.listener(move |main, _, _, cx| choose(main, value, cx))),
            );
        }
        track
    }

    /// The sidebar: the pages, the providers among them, on the system's
    /// sidebar material, under the window's buttons.
    fn sidebar(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> impl IntoElement {
        let report = self.snapshot.report.as_ref();
        let groups = report.map(|r| view::groups(r, now)).unwrap_or_default();
        let attention = report.map(|r| view::attention(r, now)).unwrap_or_default();
        let mut list = v_flex()
            .id("sidebar")
            .size_full()
            .px(px(10.))
            .pb(px(12.))
            .gap(px(1.))
            .overflow_y_scroll()
            .child(self.item(Section::Overview, None, None, c, cx))
            .child(sidebar_heading("Accounts", c));
        if groups.is_empty() {
            list = list.child(
                div()
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(12.))
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
            .w(SIDEBAR)
            .h_full()
            .flex_shrink_0()
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
    /// and what trails it.
    fn item(
        &self,
        section: Section,
        color: Option<Hsla>,
        trailing: Option<AnyElement>,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self.section == section;
        let icon = match color {
            Some(color) => div()
                .size(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .child(div().size(px(9.)).rounded_full().bg(color))
                .into_any_element(),
            None => symbols::symbol(
                section.symbol(),
                if selected { c.accent } else { c.muted },
                15.,
                cx,
            )
            .map_or_else(
                || div().size(px(16.)).into_any_element(),
                |icon| {
                    div()
                        .size(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon)
                        .into_any_element()
                },
            ),
        };
        h_flex()
            .id(SharedString::from(format!("go-{section:?}")))
            .h(px(28.))
            .px(px(8.))
            .gap(px(8.))
            .rounded(px(7.))
            .when(selected, |row| row.bg(c.fg.opacity(0.1)))
            .role(Role::Tab)
            .aria_label(section.title())
            .aria_selected(selected)
            .child(icon)
            .child(div().flex_1().min_w_0().truncate().child(section.title()))
            .children(trailing)
            .on_click(cx.listener(move |main, _, _, cx| main.go(section, cx)))
    }

    /// The page's toolbar: its title, and what acts on it.
    fn toolbar(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
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
                            .tooltip("Add an account")
                            .on_click(|event, window, cx| {
                                NativeMenu::new()
                                    .menu("Sign In with Claude…", Box::new(SignInClaude))
                                    .menu("Sign In with ChatGPT…", Box::new(SignInChatGpt))
                                    .separator()
                                    .menu("Import Logins", Box::new(ImportLogins))
                                    .menu("Add an API Key…", Box::new(AddKey))
                                    .show(event.position(), window, cx);
                            }),
                    )
                    .child(
                        tool("refresh", "arrow.clockwise", c, cx)
                            .tooltip("Refresh usage")
                            .disabled(!running)
                            .on_click(move |_, _, _| app.refresh()),
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
        TitleBar::new()
            .h(TOOLBAR)
            .pl(px(20.))
            .pr(px(12.))
            .bg(c.bg)
            .border_color(c.separator)
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.section.title()),
            )
            .child(tools)
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
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
        h_flex()
            .relative()
            .size_full()
            .text_color(c.fg)
            .on_action(cx.listener(|main, _: &AddKey, _, cx| main.go(Section::Settings, cx)))
            .child(self.sidebar(&c, now, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .bg(c.bg)
                    .border_l_1()
                    .border_color(c.separator)
                    .child(self.toolbar(&c, cx))
                    .child(
                        div().flex_1().min_h_0().child(
                            v_flex()
                                .id("body")
                                .size_full()
                                .px(px(28.))
                                .pt(px(22.))
                                .pb(px(28.))
                                .gap(px(26.))
                                .overflow_y_scrollbar()
                                .children(self.sign_in(&c))
                                .child(page),
                        ),
                    ),
            )
            .children(self.notice(&c))
    }
}

/// The theme's colors this window uses, read once per frame.
#[derive(Clone, Copy)]
struct Colors {
    bg: Hsla,
    fg: Hsla,
    muted: Hsla,
    separator: Hsla,
    group: Hsla,
    control: Hsla,
    track: Hsla,
    popover: Hsla,
    good: Hsla,
    warn: Hsla,
    bad: Hsla,
    accent: Hsla,
}

impl Colors {
    fn of(cx: &App) -> Self {
        let theme = cx.theme();
        Self {
            bg: theme.background,
            fg: theme.foreground,
            muted: theme.muted_foreground,
            separator: theme.border,
            group: theme.group_box,
            control: theme.button,
            track: theme.muted,
            popover: theme.popover,
            good: theme.success,
            warn: theme.warning,
            bad: theme.danger,
            accent: theme.primary,
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

/// A toolbar button showing an SF Symbol.
fn tool(id: &'static str, symbol: &'static str, c: &Colors, cx: &mut App) -> Button {
    Button::new(id)
        .border_0()
        .px(px(8.))
        .children(symbols::symbol(symbol, c.fg.opacity(0.75), 15., cx))
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
