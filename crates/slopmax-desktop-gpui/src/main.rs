//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar icon showing each pool's use.
//!
//! It dresses as a Mac app: the system's appearance and accent color,
//! AppKit's colors, type sizes and control heights, a title bar drawn as a
//! toolbar, and the standard menus and shortcuts.

mod usage;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{self, Input, InputState};
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, Theme, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_tray::{Icon, Tray};
use slopmax_app::history::Range;
use slopmax_app::view::{self, Credits, Gauge, Group, Label, Overview, Row, Share};
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
        Zoom
    ]
);

const TRAY_ICON: &[u8] = include_bytes!("../../../assets/tray.svg");

/// The API-key providers, in the order the key row offers them.
const KEYS: [ProviderId; 3] = [ProviderId::Anthropic, ProviderId::OpenAI, ProviderId::Xai];

/// The title bar's height, a Mac toolbar's.
const TOOLBAR: Pixels = px(52.);
/// The width of an account's name.
const NAME: Pixels = px(220.);
/// How often the Usage page rereads the ledger while it shows.
const HISTORY_EVERY: Duration = Duration::from_secs(60);

/// What the window shows, as the toolbar's switch picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Page {
    Accounts,
    Usage,
}

/// What the menu bar icon's actions reach.
struct Shared {
    app: Arc<Slopmax>,
    tray: Option<Tray>,
    window: Option<AnyWindowHandle>,
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
        cx.on_action(|_: &Refresh, cx| cx.global::<Shared>().app.refresh());
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
        cx.on_action(|_: &CloseWindow, cx| front_window(cx, |window| window.remove_window()));
        cx.on_action(|_: &Minimize, cx| front_window(cx, |window| window.minimize_window()));
        cx.on_action(|_: &Zoom, cx| front_window(cx, |window| window.zoom_window()));
        menus(cx);
        let tray = menu_bar_icon(cx)
            .inspect_err(|e| eprintln!("slopmax: no menu bar icon: {e}"))
            .ok();
        cx.set_global(Shared {
            app,
            tray,
            window: None,
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
    ]);
    cx.set_menus([
        Menu::new("slopmax").items([
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide slopmax", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit slopmax", Quit),
        ]),
        Menu::new("File").items([MenuItem::action("Close Window", CloseWindow)]),
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
        menu_bar_glyph();
        Ok(tray)
    } else {
        let image = Image::from_bytes(ImageFormat::Svg, TRAY_ICON.to_vec());
        tray.icon(Icon::from_gpui(&image, cx)?).build(cx)
    }
}

/// Gives the menu bar item the system's three rising bars, a template image
/// that macOS sizes for the menu bar and tints with it, light or dark.
#[cfg(target_os = "macos")]
fn menu_bar_glyph() {
    use objc2::MainThreadMarker;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSApplication, NSImage, NSStatusBarButton, NSView};
    use objc2_foundation::NSString;

    fn set(view: Retained<NSView>, glyph: &NSImage) {
        match view.downcast::<NSStatusBarButton>() {
            Ok(button) => button.setImage(Some(glyph)),
            Err(view) => view.subviews().iter().for_each(|view| set(view, glyph)),
        }
    }

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(glyph) = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str("chart.bar.fill"),
        Some(&NSString::from_str("slopmax")),
    ) else {
        return;
    };
    // The item's button sits in a status bar window of the app's own.
    for window in NSApplication::sharedApplication(mtm).windows() {
        if let Some(content) = window.contentView() {
            set(content, &glyph);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn menu_bar_glyph() {}

/// Brings the window forward, opening it again if it was closed.
fn open_window(cx: &mut App) {
    if let Some(window) = cx.global::<Shared>().window
        && window
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return;
    }
    let app = cx.global::<Shared>().app.clone();
    let options = WindowOptions {
        titlebar: Some(TitlebarOptions {
            title: Some("slopmax".into()),
            // Centered in the toolbar, where a Mac window with one keeps them.
            traffic_light_position: Some(point(px(20.), px(19.))),
            ..TitleBar::title_bar_options()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1000.), px(760.)),
            cx,
        ))),
        window_min_size: Some(size(px(880.), px(480.))),
        ..TitleBar::window_options()
    };
    match gpui_kit::open_window(options, cx, |window, cx| {
        macos_theme(window, cx);
        cx.new(|cx| Main::new(app, window, cx))
    }) {
        Ok((window, _)) => cx.global_mut::<Shared>().window = Some(window),
        Err(e) => eprintln!("slopmax: could not open the window: {e:#}"),
    }
}

/// Dresses gpui-kit's theme as macOS: AppKit's colors for the window's light
/// or dark appearance, as macOS 26 and later draw them, the accent color
/// chosen in System Settings, and the system's 13-point type, which also
/// brings the controls down to AppKit's heights.
fn macos_theme(window: &mut Window, cx: &mut App) {
    Theme::change(window.appearance(), Some(window), cx);
    let accent = system_accent().unwrap_or_else(|| rgb(0x007aff).into());
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

/// The accent color chosen in System Settings, as AppKit resolves it for the
/// app's appearance. GPUI does not pass it on.
#[cfg(target_os = "macos")]
fn system_accent() -> Option<Hsla> {
    use std::cell::Cell;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSColor, NSColorSpace};

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

#[cfg(not(target_os = "macos"))]
fn system_accent() -> Option<Hsla> {
    None
}

struct Main {
    app: Arc<Slopmax>,
    snapshot: Snapshot,
    key: Entity<InputState>,
    key_provider: ProviderId,
    paste: Entity<InputState>,
    page: Page,
    range: Range,
    /// When the history was last asked for.
    asked: Option<Instant>,
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
        // The accounts' countdowns move every second; the Usage page rereads
        // the ledger now and then.
        let tick = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let ticked = this.update(cx, |main, cx| match main.page {
                    Page::Accounts => cx.notify(),
                    Page::Usage => {
                        if main.asked.is_none_or(|at| at.elapsed() >= HISTORY_EVERY) {
                            main.load_history();
                        }
                    }
                });
                if ticked.is_err() {
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
        Self {
            snapshot: app.snapshot(),
            app,
            key,
            key_provider: ProviderId::Anthropic,
            paste,
            page: Page::Accounts,
            range: Range::default(),
            asked: None,
            credits_open: HashSet::new(),
            confirming: None,
            _tasks: [follow, tick],
            _system: [appearance, activation],
        }
    }

    fn load_history(&mut self) {
        self.app.load_history(self.range);
        self.asked = Some(Instant::now());
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

    /// The title bar, drawn as a Mac toolbar: the title with the proxy's
    /// state beneath it, the switch between pages, and the proxy's commands.
    fn toolbar(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let (app, app2, app3) = (self.app.clone(), self.app.clone(), self.app.clone());
        let pages = self
            .segmented(
                "page",
                [(Page::Accounts, "Accounts"), (Page::Usage, "Usage")],
                self.page,
                |main, page, cx| {
                    main.page = page;
                    if page == Page::Usage {
                        main.load_history();
                    }
                    cx.notify();
                },
                c,
                cx,
            )
            // A press on a segment is a click, never a window drag.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
        TitleBar::new()
            .h(TOOLBAR)
            .pl(px(88.))
            .pr(px(14.))
            .bg(c.bg)
            .border_color(c.separator)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(15.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("slopmax"),
                    )
                    .child(
                        h_flex()
                            .gap(px(5.))
                            .text_size(px(11.))
                            .text_color(c.muted)
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .size(px(7.))
                                    .rounded_full()
                                    .bg(if running { c.good } else { c.muted }),
                            )
                            .child(div().truncate().child(view::proxy_line(&self.snapshot))),
                    ),
            )
            // Centered, the title and the commands taking equal sides.
            .child(pages)
            .child(
                h_flex()
                    .flex_1()
                    .justify_end()
                    .gap(px(8.))
                    // A press on a button is a click, never a window drag.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        push("proxy", if running { "Stop proxy" } else { "Start proxy" }).on_click(
                            move |_, _, _| {
                                if running {
                                    app.stop_proxy();
                                } else {
                                    app.start_proxy();
                                }
                            },
                        ),
                    )
                    .child(
                        push("refresh", "Refresh usage")
                            .disabled(!running)
                            .on_click(move |_, _, _| app2.refresh()),
                    )
                    .child(
                        push("dashboard", "Dashboard")
                            .disabled(!running)
                            .on_click(move |_, _, _| app3.open_dashboard()),
                    ),
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

    fn accounts(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> impl IntoElement {
        let groups = self
            .snapshot
            .report
            .as_ref()
            .map(|report| view::groups(report, now))
            .unwrap_or_default();
        let mut body = v_flex().gap(px(22.)).children(overview(&groups, c));
        if groups.is_empty() {
            body = body.child(section("Accounts", c).child(group_box(c).py(px(10.)).child(
                div().text_color(c.muted).child(
                    "No accounts yet. Sign in below, or import the logins Claude Code, \
                         Codex, or CLIProxyAPI already have.",
                ),
            )));
        }
        for group in &groups {
            body = body.child(self.group(group, c, cx));
        }
        body.child(section("Add an account", c).child(self.add(c, cx)))
    }

    /// Ways to add an account: signing in, importing, or an API key.
    fn add(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let (claude, chatgpt, import) = (self.app.clone(), self.app.clone(), self.app.clone());
        let (app, key, provider) = (self.app.clone(), self.key.clone(), self.key_provider);
        group_box(c)
            .child(
                h_flex()
                    .py(px(8.))
                    .gap(px(8.))
                    .child(div().w(px(90.)).flex_shrink_0().child("Sign in"))
                    .child(
                        push("sign-in-claude", "Sign in with Claude")
                            .on_click(move |_, _, _| claude.sign_in(ProviderId::Claude)),
                    )
                    .child(
                        push("sign-in-chatgpt", "Sign in with ChatGPT")
                            .on_click(move |_, _, _| chatgpt.sign_in(ProviderId::Codex)),
                    )
                    .child(
                        push("import", "Import logins").on_click(move |_, _, _| import.import()),
                    ),
            )
            .child(
                h_flex()
                    .py(px(8.))
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(c.separator)
                    .child(div().w(px(90.)).flex_shrink_0().child("API key"))
                    .child(self.key_providers(c, cx))
                    .child(div().flex_1().child(field(&self.key)))
                    .child(push("add-key", "Add key").on_click(move |_, window, cx| {
                        let value = key.read(cx).value().to_string();
                        if !value.is_empty() {
                            app.add_key(provider, value);
                            key.update(cx, |input, cx| input.set_value("", window, cx));
                        }
                    })),
            )
    }

    /// The API-key providers to add a key for.
    fn key_providers(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        self.segmented(
            "key",
            KEYS.map(|provider| (provider, provider.spec().title)),
            self.key_provider,
            |main, provider, cx| {
                main.key_provider = provider;
                cx.notify();
            },
            c,
            cx,
        )
    }

    /// The Usage page: its range, then the charts.
    fn usage(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let history = self
            .snapshot
            .history
            .as_ref()
            .filter(|h| h.range == self.range);
        v_flex()
            .gap(px(16.))
            .child(
                h_flex()
                    .child(heading("Usage", c))
                    .child(div().flex_1())
                    .child(self.segmented(
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
            )
            .child(match history {
                Some(history) => usage::page(history, c),
                None => div()
                    .p(px(32.))
                    .text_color(c.muted)
                    .child("Reading the ledger…"),
            })
    }

    /// A provider's accounts: a heading, then a row each.
    fn group(&self, group: &Group, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let auto = self.app.clone();
        let pinned = group.accounts.iter().any(|row| row.pinned);
        let mut list = group_box(c);
        for (i, row) in group.accounts.iter().enumerate() {
            list = list.child(self.row(row, group, i == 0, c, cx));
        }
        v_flex()
            .gap(px(8.))
            .child(
                h_flex()
                    .px(px(4.))
                    .gap(px(6.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(group.title))
                    .child(
                        div()
                            .text_color(c.muted)
                            .child(group.accounts.len().to_string()),
                    )
                    .child(div().flex_1())
                    // Only a pin has anything to undo.
                    .when(pinned, |heading| {
                        heading.child(
                            push(
                                SharedString::from(format!("unpin-{}", group.provider)),
                                "Let slopmax choose",
                            )
                            .small()
                            .on_click(move |_, _, _| auto.unpin_all()),
                        )
                    }),
            )
            .child(list)
    }

    /// An account: its name, plan, and standing, a column for each of its
    /// usage windows, and its switches; beneath, its reset credits when
    /// opened.
    fn row(
        &self,
        row: &Row,
        group: &Group,
        first: bool,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let limits = &group.limits;
        let (pin, toggle) = (self.app.clone(), self.app.clone());
        let (id, id2) = (row.id.clone(), row.id.clone());
        let open = row.credits.is_some() && self.credits_open.contains(&row.id);
        // Out of quota on one window, it waits on that one alone, so the
        // others fade.
        let held = row.limits.iter().flatten().any(|g| g.fraction >= 1.0);
        let line = h_flex()
            .gap(px(20.))
            .child(
                v_flex()
                    .w(NAME)
                    .flex_shrink_0()
                    .gap(px(3.))
                    .child(
                        div()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if row.disabled { c.muted } else { c.fg })
                            .child(row.name.clone()),
                    )
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap(px(6.))
                            .text_size(px(11.))
                            .text_color(c.muted)
                            .when(!row.plan.is_empty(), |line| {
                                line.child(row.plan.clone()).child("·")
                            })
                            .child(label(&row.status, c))
                            .when_some(row.last_used.clone(), |line, used| {
                                line.child("·").child(div().flex_shrink_0().child(used))
                            }),
                    )
                    .when(!row.notes.is_empty() || row.credits.is_some(), |name| {
                        name.child(
                            h_flex()
                                .gap(px(10.))
                                .overflow_hidden()
                                .text_size(px(11.))
                                .text_color(c.muted)
                                .children(
                                    row.credits
                                        .as_ref()
                                        .map(|credits| disclosure(row, credits, open, c, cx)),
                                )
                                // Only the last note gives way, so a long
                                // error never squeezes the short ones.
                                .children(row.notes.iter().enumerate().map(|(i, note)| {
                                    label(note, c)
                                        .when(i + 1 < row.notes.len(), |note| note.flex_shrink_0())
                                })),
                        )
                    }),
            )
            .children(limits.iter().zip(&row.limits).map(|(title, gauge)| {
                let faded =
                    row.disabled || (held && gauge.as_ref().is_some_and(|g| g.fraction < 1.0));
                limit(title, gauge.as_ref(), faded, c)
            }))
            .when(limits.is_empty(), |line| line.child(div().flex_1()));
        let panel = row
            .credits
            .as_ref()
            .filter(|_| open)
            .map(|credits| self.credits(row, credits, group.title, c, cx));
        v_flex()
            .py(px(12.))
            .gap(px(12.))
            .when(!first, |row| row.border_t_1().border_color(c.separator))
            .child(
                line.child(
                    h_flex()
                        .flex_shrink_0()
                        .gap(px(12.))
                        .child(
                            push(
                                SharedString::from(format!("use-{}", row.id)),
                                if row.pinned { "Pinned" } else { "Use" },
                            )
                            .accessibility_label(format!(
                                "{} {}",
                                if row.pinned { "Pinned" } else { "Use" },
                                row.name
                            ))
                            .small()
                            .disabled(row.pinned || row.disabled)
                            .on_click(move |_, _, _| pin.pin(&id)),
                        )
                        .child(
                            Switch::new(SharedString::from(format!("enabled-{}", row.id)))
                                .checked(!row.disabled)
                                .accessibility_label(format!("Enable {}", row.name))
                                .on_click(move |enabled, _, _| {
                                    toggle.set_disabled(&id2, !*enabled)
                                }),
                        ),
                ),
            )
            .children(panel)
    }

    /// An account's reset credits: when each was granted and expires, what
    /// redeeming one clears, and the button that does, which asks first.
    fn credits(
        &self,
        row: &Row,
        credits: &Credits,
        provider: &str,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let redeeming = self.snapshot.redeeming.as_deref() == Some(row.id.as_str());
        let confirming = self.confirming.as_deref() == Some(row.id.as_str());
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let held = credits
            .held
            .clone()
            .or_else(|| (!running).then(|| "Start the proxy to redeem one".to_owned()));
        let id = row.id.clone();
        let action = if redeeming {
            h_flex().child(caption("Redeeming…", c))
        } else if confirming {
            let app = self.app.clone();
            h_flex()
                .gap(px(8.))
                .child(div().text_size(px(12.)).child("Redeem one now?"))
                .child(
                    push(SharedString::from(format!("keep-{id}")), "Cancel")
                        .small()
                        .on_click(cx.listener(|main, _, _, cx| {
                            main.confirming = None;
                            cx.notify();
                        })),
                )
                .child(
                    Button::new(SharedString::from(format!("redeem-{id}")))
                        .label("Redeem")
                        .primary()
                        .small()
                        .accessibility_label(format!("Redeem it now on {}", row.name))
                        .on_click(cx.listener(move |main, _, _, cx| {
                            main.confirming = None;
                            app.redeem(&id);
                            cx.notify();
                        })),
                )
        } else {
            h_flex()
                .gap(px(10.))
                .children(held.as_deref().map(|why| caption(why, c)))
                .child(
                    push(
                        SharedString::from(format!("ask-redeem-{id}")),
                        "Redeem one…",
                    )
                    .small()
                    .disabled(held.is_some())
                    .accessibility_label(format!("Redeem a reset credit on {}…", row.name))
                    .on_click(cx.listener(move |main, _, _, cx| {
                        main.confirming = Some(id.clone());
                        cx.notify();
                    })),
                )
        };
        let mut panel = v_flex()
            .p(px(12.))
            .gap(px(10.))
            .rounded(px(8.))
            .bg(c.fg.opacity(0.04))
            .child(
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
                                    .child("Reset credits"),
                            )
                            .child(caption(
                                &format!(
                                    "Each one resets this account's {} windows at once.",
                                    credits.clears
                                ),
                                c,
                            )),
                    )
                    .child(action),
            );
        if credits.credits.is_empty() {
            panel = panel.child(caption("Listing them…", c));
        }
        for credit in &credits.credits {
            panel = panel.child(
                h_flex()
                    .gap(px(8.))
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(c.separator)
                    .child(dot(match credit.tone {
                        Tone::Muted => c.muted,
                        tone => c.tone(tone),
                    }))
                    .child(credit.expires.clone())
                    .children(credit.left.as_ref().map(|left| {
                        div()
                            .text_color(match credit.tone {
                                Tone::Muted => c.muted,
                                tone => c.tone(tone),
                            })
                            .child(left.clone())
                    }))
                    .child(div().flex_1())
                    .children(credit.granted.as_deref().map(|granted| caption(granted, c))),
            );
        }
        panel.children(
            view::auto_redeem(self.app.config(), provider)
                .map(|policy| caption(&policy, c).pt(px(2.))),
        )
    }

    fn agents(&self, c: &Colors) -> impl IntoElement {
        let mut list = group_box(c);
        for (i, agent) in self.snapshot.agents.iter().enumerate() {
            let (state, connected) = view::agent_line(agent);
            let (app, id) = (self.app.clone(), agent.id);
            list = list.child(
                h_flex()
                    .py(px(8.))
                    .gap(px(12.))
                    .when(i > 0, |row| row.border_t_1().border_color(c.separator))
                    .child(div().w(px(140.)).flex_shrink_0().child(agent.title))
                    .child(label(
                        &Label {
                            text: state,
                            tone: if connected { Tone::Good } else { Tone::Muted },
                        },
                        c,
                    ))
                    .child(div().flex_1())
                    .child(
                        push(
                            SharedString::from(format!("agent-{id}")),
                            if connected { "Disconnect" } else { "Connect" },
                        )
                        .accessibility_label(format!(
                            "{} {}",
                            if connected { "Disconnect" } else { "Connect" },
                            agent.title
                        ))
                        .on_click(move |_, _, _| {
                            if connected {
                                app.disconnect_agent(id);
                            } else {
                                app.connect_agent(id);
                            }
                        }),
                    ),
            );
        }
        section("Agents", c).child(list)
    }

    fn background(&self, c: &Colors) -> impl IntoElement {
        let (state, can_install) = view::service_line(self.snapshot.service.as_ref());
        let app = self.app.clone();
        let mut line = h_flex()
            .py(px(8.))
            .gap(px(12.))
            .child(
                div()
                    .w(NAME)
                    .flex_shrink_0()
                    .child(self.snapshot.address.clone()),
            )
            .child(div().flex_1().text_color(c.muted).child(state));
        if can_install {
            line = line.child(
                push("install-service", "Start at login")
                    .on_click(move |_, _, _| app.install_service()),
            );
        }
        section("Background", c).child(group_box(c).child(line))
    }
}

impl Render for Main {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Colors::of(cx);
        let now = Timestamp::now();
        v_flex()
            .relative()
            .size_full()
            .bg(c.bg)
            .text_color(c.fg)
            .child(self.toolbar(&c, cx))
            .child(
                div().flex_1().min_h_0().child(
                    v_flex()
                        .id("body")
                        .size_full()
                        .px(px(20.))
                        .pt(px(16.))
                        .pb(px(20.))
                        .gap(px(22.))
                        .overflow_y_scrollbar()
                        .children(self.sign_in(&c))
                        .map(|body| match self.page {
                            Page::Accounts => body
                                .child(self.accounts(&c, now, cx))
                                .child(self.agents(&c))
                                .child(self.background(&c)),
                            Page::Usage => body.child(self.usage(&c, cx)),
                        }),
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
}

/// A Mac push button: a gray rounded rectangle without a border.
fn push(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    Button::new(id).label(label).border_0()
}

/// A Mac text field: 13-point text, with room for it at a control's height.
fn field(state: &Entity<InputState>) -> Input {
    Input::new(state).py(px(3.)).text_size(px(13.))
}

/// A part of the window as System Settings draws one: a heading over its
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

/// The way to an account's reset credits: their count, and a triangle that
/// turns down while they show.
fn disclosure(
    row: &Row,
    credits: &Credits,
    open: bool,
    c: &Colors,
    cx: &mut Context<Main>,
) -> impl IntoElement {
    let id = row.id.clone();
    h_flex()
        .id(SharedString::from(format!("credits-{}", row.id)))
        .flex_shrink_0()
        .gap(px(4.))
        .text_color(c.accent)
        .cursor_pointer()
        .role(Role::DisclosureTriangle)
        .aria_label(format!("{} on {}", credits.title, row.name))
        .aria_expanded(open)
        .child(credits.title.clone())
        .child(if open { "▾" } else { "▸" })
        .on_click(cx.listener(move |main, _, _, cx| {
            if !main.credits_open.remove(&id) {
                main.credits_open.insert(id.clone());
            }
            if main.confirming.as_ref() == Some(&id) {
                main.confirming = None;
            }
            cx.notify();
        }))
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

/// Each subscription's usage windows across its accounts, as agents see
/// them: one card, a column per provider.
fn overview(groups: &[Group], c: &Colors) -> Option<Div> {
    let groups: Vec<&Group> = groups.iter().filter(|g| !g.overview.is_empty()).collect();
    if groups.is_empty() {
        return None;
    }
    Some(
        h_flex()
            .items_stretch()
            .rounded(px(12.))
            .bg(c.group)
            .children(groups.into_iter().enumerate().map(|(i, group)| {
                let total = group.accounts.len();
                let noun = if total == 1 { "account" } else { "accounts" };
                let accounts = if group.working == total {
                    format!("{total} {noun}")
                } else {
                    format!("{} of {total} {noun} working", group.working)
                };
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .p(px(16.))
                    .gap(px(14.))
                    .when(i > 0, |card| card.border_l_1().border_color(c.separator))
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(group.title))
                            .child(div().flex_1())
                            .child(caption(&accounts, c)),
                    )
                    .child(
                        h_flex()
                            .items_start()
                            .gap(px(20.))
                            .children(group.overview.iter().map(|o| metric(o, c))),
                    )
                    .children(group.credits.as_deref().map(|credits| {
                        h_flex()
                            .gap(px(6.))
                            .text_size(px(11.))
                            .text_color(c.accent)
                            .child("↺")
                            .child(credits.to_owned())
                    }))
            })),
    )
}

/// A window across the pool: its use, large, over each account's share.
fn metric(overview: &Overview, c: &Colors) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(6.))
        .child(caption(&overview.title, c))
        .child(
            h_flex()
                .items_end()
                .gap(px(4.))
                .child(
                    div()
                        .text_size(px(26.))
                        .line_height(px(30.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(overview.gauge.percent.clone()),
                )
                .child(div().pb(px(4.)).text_color(c.muted).child("used")),
        )
        .child(segments(&overview.shares, c))
        .child(resets(&overview.gauge, c))
}

/// A segment per account, each filled to its use; an account out of the
/// pool fades.
fn segments(shares: &[Share], c: &Colors) -> Div {
    h_flex().gap(px(3.)).children(shares.iter().map(|share| {
        bar(share.fraction, c.tone(share.tone), c)
            .flex_1()
            .when(share.idle, |bar| bar.opacity(0.35))
    }))
}

/// One usage window of an account: its use over a bar marked where an even
/// spend would be, when it resets, and how its pace compares.
fn limit(title: &str, gauge: Option<&Gauge>, faded: bool, c: &Colors) -> Div {
    let cell = v_flex()
        .flex_1()
        .min_w(px(140.))
        .gap(px(6.))
        .when(faded, |cell| cell.opacity(0.4));
    let Some(g) = gauge else {
        return cell;
    };
    cell.child(
        h_flex()
            .child(caption(title, c))
            .child(div().flex_1())
            .child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(g.percent.clone()),
            ),
    )
    .child(
        bar(g.fraction, c.tone(g.tone), c).when_some(g.pace.as_ref(), |bar, pace| {
            bar.relative().child(
                div()
                    .absolute()
                    .left(relative(pace.elapsed))
                    .top(px(-3.))
                    .w(px(2.))
                    .h(px(11.))
                    .rounded_full()
                    .bg(c.fg.opacity(0.55)),
            )
        }),
    )
    .child(resets(g, c))
    .when_some(g.pace.as_ref(), |cell, pace| {
        cell.child(
            div()
                .text_size(px(11.))
                .text_color(c.tone(pace.label.tone))
                .child(pace.label.text.clone()),
        )
    })
}

fn bar(fraction: f32, color: Hsla, c: &Colors) -> Div {
    div().h(px(5.)).rounded_full().bg(c.track).child(
        div()
            .h_full()
            .w(relative(fraction))
            .rounded_full()
            .bg(color),
    )
}

/// `in 1h07m · 22:59`, or that nothing waits to reset.
fn resets(gauge: &Gauge, c: &Colors) -> Div {
    let line = h_flex().gap(px(5.)).text_size(px(11.)).text_color(c.muted);
    match (&gauge.resets_in, &gauge.resets_at) {
        (Some(left), Some(at)) => line
            .child(div().text_color(c.fg).child(format!("in {left}")))
            .child("·")
            .child(at.clone()),
        _ => line.child("No reset pending"),
    }
}
