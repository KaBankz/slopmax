//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar icon showing each pool's use.
//!
//! It dresses as a Mac app: the system's appearance and accent color,
//! AppKit's colors, type sizes and control heights, a title bar drawn as a
//! toolbar, and the standard menus and shortcuts.

use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::button::Button;
use gpui_kit::component::input::{self, Input, InputState};
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, Theme, TitleBar, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_tray::{Icon, Tray};
use slopmax_app::view::{self, Gauge, Group, Label, Row};
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
/// The widths of an account's name and of each usage gauge.
const NAME: Pixels = px(230.);
const GAUGE: Pixels = px(180.);

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
    let image = Image::from_bytes(ImageFormat::Svg, TRAY_ICON.to_vec());
    Tray::builder()
        .icon(Icon::from_gpui(&image, cx)?)
        .title("slopmax")
        .tooltip("slopmax")
        .menu(|_| {
            vec![
                MenuItem::action("Open slopmax", OpenWindow),
                MenuItem::action("Refresh usage", Refresh),
                MenuItem::separator(),
                MenuItem::action("Quit", Quit),
            ]
        })
        .build(cx)
}

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
        // Countdowns move every second.
        let tick = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
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
            _tasks: [follow, tick],
            _system: [appearance, activation],
        }
    }

    /// The title bar, drawn as a Mac toolbar: the title with the proxy's
    /// state beneath it, and the proxy's commands.
    fn toolbar(&self, c: &Colors) -> impl IntoElement {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let (app, app2, app3) = (self.app.clone(), self.app.clone(), self.app.clone());
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
            .child(
                h_flex()
                    .flex_shrink_0()
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
        let auto = self.app.clone();
        let mut section = v_flex().gap(px(8.)).child(
            h_flex().child(heading("Accounts", c).flex_1()).child(
                push("unpin-all", "Let slopmax choose")
                    .small()
                    .on_click(move |_, _, _| auto.unpin_all()),
            ),
        );
        if groups.is_empty() {
            section = section.child(group_box(c).py(px(10.)).child(
                div().text_color(c.muted).child(
                    "No accounts yet. Sign in below, or import the logins Claude Code, Codex, or \
                     CLIProxyAPI already have.",
                ),
            ));
        }
        for group in &groups {
            section = section.child(self.group(group, c));
        }
        section.child(self.add(c, cx))
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

    /// The API-key providers as a Mac segmented control, the chosen one
    /// filled with the accent color.
    fn key_providers(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let mut track = h_flex()
            .flex_shrink_0()
            .h(rems(2.))
            .rounded(px(6.))
            .bg(c.control);
        for (i, provider) in KEYS.into_iter().enumerate() {
            let selected = provider == self.key_provider;
            // Unchosen neighbors are divided by a short rule.
            if i > 0 && !selected && KEYS[i - 1] != self.key_provider {
                track = track.child(div().w(px(1.)).h(px(12.)).bg(c.fg.opacity(0.3)));
            }
            track = track.child(
                div()
                    .id(SharedString::from(format!("key-{provider}")))
                    .h_full()
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .role(Role::RadioButton)
                    .aria_label(provider.spec().title)
                    .aria_selected(selected)
                    .when(selected, |segment| segment.bg(c.accent).text_color(white()))
                    .child(provider.spec().title)
                    .on_click(cx.listener(move |main, _, _, cx| {
                        main.key_provider = provider;
                        cx.notify();
                    })),
            );
        }
        track
    }

    fn group(&self, group: &Group, c: &Colors) -> impl IntoElement {
        let mut header = h_flex().pt(px(10.)).pb(px(6.)).gap(px(12.)).child(
            div()
                .w(NAME)
                .flex_shrink_0()
                .font_weight(FontWeight::SEMIBOLD)
                .child(group.title),
        );
        if group.subscription {
            header = header
                .child(caption("5 Hours", c).w(GAUGE).flex_shrink_0())
                .child(caption("Week", c).w(GAUGE).flex_shrink_0());
        }
        let mut list = group_box(c).child(header.child(caption("Status", c).flex_1()));
        for row in &group.accounts {
            list = list.child(self.row(row, group.subscription, c));
        }
        if let Some(pool) = &group.pool {
            // The pool reads as a highlighted row, as a Mac list marks one.
            list = list.child(
                h_flex()
                    .mx(px(-6.))
                    .mb(px(6.))
                    .px(px(6.))
                    .py(px(8.))
                    .gap(px(12.))
                    .rounded(px(6.))
                    .bg(c.accent.opacity(0.1))
                    .child(
                        v_flex()
                            .w(NAME)
                            .flex_shrink_0()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child("Pool"))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(c.muted)
                                    .child(format!("{} accounts as one", pool.accounts)),
                            ),
                    )
                    .child(gauge(pool.five_hour.as_ref(), c))
                    .child(gauge(pool.week.as_ref(), c))
                    .child(
                        div()
                            .flex_1()
                            .text_color(c.muted)
                            .child("What the agents see"),
                    ),
            );
        }
        list
    }

    fn row(&self, row: &Row, subscription: bool, c: &Colors) -> impl IntoElement {
        let (pin, toggle) = (self.app.clone(), self.app.clone());
        let (id, id2) = (row.id.clone(), row.id.clone());
        let mut line = h_flex()
            .py(px(8.))
            .gap(px(12.))
            .border_t_1()
            .border_color(c.separator)
            .child(
                v_flex()
                    .w(NAME)
                    .flex_shrink_0()
                    .child(
                        div()
                            .truncate()
                            .text_color(if row.disabled { c.muted } else { c.fg })
                            .child(row.name.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(c.muted)
                            .child(row.plan.clone()),
                    ),
            );
        if subscription {
            line = line
                .child(gauge(row.five_hour.as_ref(), c))
                .child(gauge(row.week.as_ref(), c));
        }
        line.child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(2.))
                .child(label(&row.status, c))
                .child(
                    h_flex()
                        .gap(px(10.))
                        .overflow_hidden()
                        .text_size(px(11.))
                        // Only the last note gives way, so a long error
                        // never squeezes the short ones before it.
                        .children(row.notes.iter().enumerate().map(|(i, note)| {
                            label(note, c)
                                .when(i + 1 < row.notes.len(), |note| note.flex_shrink_0())
                        })),
                ),
        )
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
                .on_click(move |enabled, _, _| toggle.set_disabled(&id2, !*enabled)),
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
            .child(self.toolbar(&c))
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
                        .child(self.accounts(&c, now, cx))
                        .child(self.agents(&c))
                        .child(self.background(&c)),
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

fn gauge(gauge: Option<&Gauge>, c: &Colors) -> Div {
    let cell = h_flex().w(GAUGE).flex_shrink_0().gap(px(8.));
    let Some(g) = gauge else {
        return cell.child(div().text_color(c.muted).child("—"));
    };
    cell.child(
        div().w(px(96.)).h(px(6.)).rounded_full().bg(c.track).child(
            div()
                .h_full()
                .w(relative(g.fraction))
                .rounded_full()
                .bg(c.tone(g.tone)),
        ),
    )
    .child(
        div()
            .w(px(34.))
            .flex()
            .justify_end()
            .text_size(px(11.))
            .child(g.percent.clone()),
    )
    .child(
        div()
            .text_size(px(11.))
            .text_color(c.muted)
            .child(g.resets_in.clone().unwrap_or_default()),
    )
}
