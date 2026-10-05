//! The slopmax desktop app drawn with GPUI: a window over slopmax-app's
//! snapshot, and a menu bar icon showing each pool's use.

use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, h_flex, v_flex};
use gpui_kit::*;
use gpui_tray::{Icon, Tray};
use slopmax_app::view::{self, Gauge, Group, Label, Row};
use slopmax_app::{App as Slopmax, Proxy, Snapshot};
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

actions!(slopmax, [OpenWindow, Refresh, Quit]);

const ICON: &[u8] = include_bytes!("../../../assets/icon.svg");
const TRAY_ICON: &[u8] = include_bytes!("../../../assets/tray.svg");

/// The API-key providers, in the order the key row offers them.
const KEYS: [ProviderId; 3] = [ProviderId::Anthropic, ProviderId::OpenAI, ProviderId::Xai];

/// What the menu bar icon's actions reach.
struct Shared {
    app: Arc<Slopmax>,
    tray: Option<Tray>,
    window: Option<AnyWindowHandle>,
}

impl Global for Shared {}

fn main() -> anyhow::Result<()> {
    let app = Arc::new(Slopmax::start()?);
    gpui_kit::application()
        // Closing the window leaves the menu bar icon, whose Quit ends the app.
        .with_quit_mode(QuitMode::Explicit)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.on_action(|_: &OpenWindow, cx| open_window(cx));
            cx.on_action(|_: &Refresh, cx| cx.global::<Shared>().app.refresh());
            cx.on_action(|_: &Quit, cx| cx.quit());
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
            ..Default::default()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1100.), px(760.)),
            cx,
        ))),
        ..Default::default()
    };
    match gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| Main::new(app, window, cx))
    }) {
        Ok((window, _)) => cx.global_mut::<Shared>().window = Some(window),
        Err(e) => eprintln!("slopmax: could not open the window: {e:#}"),
    }
}

struct Main {
    app: Arc<Slopmax>,
    snapshot: Snapshot,
    key: Entity<InputState>,
    key_provider: ProviderId,
    paste: Entity<InputState>,
    _tasks: [Task<()>; 2],
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
        Self {
            snapshot: app.snapshot(),
            app,
            key,
            key_provider: ProviderId::Anthropic,
            paste,
            _tasks: [follow, tick],
        }
    }

    fn header(&self, c: &Colors) -> impl IntoElement {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let (app, app2, app3) = (self.app.clone(), self.app.clone(), self.app.clone());
        h_flex()
            .h(px(56.))
            .px_6()
            .gap_3()
            .border_b_1()
            .border_color(c.border)
            .child(img(Arc::new(Image::from_bytes(ImageFormat::Svg, ICON.to_vec()))).size(px(26.)))
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child("slopmax"),
            )
            .child(
                div()
                    .size(px(10.))
                    .rounded_full()
                    .bg(if running { c.good } else { c.muted }),
            )
            .child(
                div()
                    .flex_1()
                    .text_color(c.muted)
                    .truncate()
                    .child(view::proxy_line(&self.snapshot)),
            )
            .child(
                Button::new("proxy")
                    .label(if running { "Stop proxy" } else { "Start proxy" })
                    .on_click(move |_, _, _| {
                        if running {
                            app.stop_proxy();
                        } else {
                            app.start_proxy();
                        }
                    }),
            )
            .child(
                Button::new("refresh")
                    .label("Refresh usage")
                    .disabled(!running)
                    .on_click(move |_, _, _| app2.refresh()),
            )
            .child(
                Button::new("dashboard")
                    .label("Dashboard")
                    .disabled(!running)
                    .on_click(move |_, _, _| app3.open_dashboard()),
            )
    }

    fn notice(&self, c: &Colors) -> Option<impl IntoElement> {
        let notice = self.snapshot.notice.as_ref()?;
        let app = self.app.clone();
        let tint = if notice.error { c.bad } else { c.good };
        // Floats over the corner, so it never moves what is under the pointer.
        Some(
            h_flex()
                .absolute()
                .right(px(20.))
                .bottom(px(20.))
                .w(px(440.))
                .p_3()
                .gap_2p5()
                .rounded_lg()
                .border_1()
                .border_color(tint)
                .bg(c.bg)
                .shadow_lg()
                .child(div().flex_1().child(notice.text.clone()))
                .child(
                    Button::new("dismiss")
                        .label("Dismiss")
                        .on_click(move |_, _, _| app.dismiss_notice()),
                ),
        )
    }

    fn sign_in(&self, c: &Colors) -> Option<impl IntoElement> {
        let sign_in = view::sign_in(self.snapshot.sign_in.as_ref()?);
        let (app, cancel) = (self.app.clone(), self.app.clone());
        let paste = self.paste.clone();
        let mut section = section(&sign_in.title, c).child(sign_in.detail);
        if let Some(code) = sign_in.code {
            section = section.child(div().text_2xl().font_weight(FontWeight::BOLD).child(code));
        }
        if let Some(link) = sign_in.link {
            let (open, copy) = (link.clone(), link.clone());
            section =
                section
                    .child(div().text_xs().text_color(c.muted).child(link))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("open-link")
                                    .label("Open again")
                                    .on_click(move |_, _, cx| cx.open_url(&open)),
                            )
                            .child(Button::new("copy-link").label("Copy").on_click(
                                move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                                },
                            )),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().child(Input::new(&self.paste)))
                            .child(Button::new("paste").label("Use address").on_click(
                                move |_, window, cx| {
                                    let address = paste.read(cx).value().to_string();
                                    app.paste(address);
                                    paste.update(cx, |input, cx| input.set_value("", window, cx));
                                },
                            )),
                    );
        }
        if !sign_in.notes.is_empty() {
            section = section.child(div().text_color(c.warn).child(sign_in.notes));
        }
        Some(
            section.child(
                h_flex().child(
                    Button::new("cancel-sign-in")
                        .label("Cancel")
                        .on_click(move |_, _, _| cancel.cancel_sign_in()),
                ),
            ),
        )
    }

    fn accounts(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> impl IntoElement {
        let groups = self
            .snapshot
            .report
            .as_ref()
            .map(|report| view::groups(report, now))
            .unwrap_or_default();
        let mut section = section("Accounts", c);
        if groups.is_empty() {
            section = section.child(div().text_color(c.muted).child(
                "No accounts yet. Sign in below, or import the logins Claude Code, Codex, or \
                 CLIProxyAPI already have.",
            ));
        }
        for group in &groups {
            section = section.child(self.group(group, c));
        }
        let (claude, chatgpt, import, auto) = (
            self.app.clone(),
            self.app.clone(),
            self.app.clone(),
            self.app.clone(),
        );
        section = section.child(
            h_flex()
                .gap_2()
                .child(
                    Button::new("sign-in-claude")
                        .label("Sign in with Claude")
                        .primary()
                        .on_click(move |_, _, _| claude.sign_in(ProviderId::Claude)),
                )
                .child(
                    Button::new("sign-in-chatgpt")
                        .label("Sign in with ChatGPT")
                        .primary()
                        .on_click(move |_, _, _| chatgpt.sign_in(ProviderId::Codex)),
                )
                .child(
                    Button::new("import")
                        .label("Import logins")
                        .on_click(move |_, _, _| import.import()),
                )
                .child(
                    Button::new("unpin-all")
                        .label("Let slopmax choose")
                        .on_click(move |_, _, _| auto.unpin_all()),
                ),
        );
        let mut keys = h_flex().gap_2();
        for provider in KEYS {
            let button = Button::new(SharedString::from(format!("key-{provider}")))
                .label(provider.spec().title)
                .on_click(cx.listener(move |main, _, _, cx| {
                    main.key_provider = provider;
                    cx.notify();
                }));
            keys = keys.child(if provider == self.key_provider {
                button.primary()
            } else {
                button
            });
        }
        let (app, key, provider) = (self.app.clone(), self.key.clone(), self.key_provider);
        section.child(
            keys.child(div().flex_1().child(Input::new(&self.key)))
                .child(
                    Button::new("add-key")
                        .label("Add key")
                        .on_click(move |_, window, cx| {
                            let value = key.read(cx).value().to_string();
                            if !value.is_empty() {
                                app.add_key(provider, value);
                                key.update(cx, |input, cx| input.set_value("", window, cx));
                            }
                        }),
                ),
        )
    }

    fn group(&self, group: &Group, c: &Colors) -> impl IntoElement {
        let mut header = h_flex()
            .gap_3()
            .child(caption(group.title, c).w(px(240.)).flex_shrink_0());
        if group.subscription {
            header = header
                .child(caption("5 hours", c).w(px(190.)).flex_shrink_0())
                .child(caption("Week", c).w(px(190.)).flex_shrink_0());
        }
        let mut list = v_flex()
            .gap_1p5()
            .child(header.child(caption("Status", c).flex_1()));
        for row in &group.accounts {
            list = list.child(self.row(row, group.subscription, c));
        }
        if let Some(pool) = &group.pool {
            list = list.child(
                h_flex()
                    .py_1p5()
                    .gap_3()
                    .rounded_md()
                    .bg(c.accent.opacity(0.08))
                    .child(
                        v_flex()
                            .w(px(240.))
                            .flex_shrink_0()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child("pool"))
                            .child(
                                div()
                                    .text_xs()
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
                            .child("what the agents see"),
                    ),
            );
        }
        list
    }

    fn row(&self, row: &Row, subscription: bool, c: &Colors) -> impl IntoElement {
        let (pin, toggle) = (self.app.clone(), self.app.clone());
        let (id, id2, disabled) = (row.id.clone(), row.id.clone(), row.disabled);
        let mut line = h_flex().py_1p5().gap_3().child(
            v_flex()
                .w(px(240.))
                .flex_shrink_0()
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .text_color(if row.disabled { c.muted } else { c.fg })
                        .child(row.name.clone()),
                )
                .child(div().text_xs().text_color(c.muted).child(row.plan.clone())),
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
                .gap_0p5()
                .child(label(&row.status, c).truncate())
                .child(
                    h_flex()
                        .gap_2()
                        .overflow_hidden()
                        .children(row.notes.iter().map(|note| label(note, c).text_xs())),
                ),
        )
        .child(
            Button::new(SharedString::from(format!("use-{}", row.id)))
                .label(if row.pinned { "Pinned" } else { "Use" })
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
            Button::new(SharedString::from(format!("toggle-{}", row.id)))
                .label(if row.disabled { "Enable" } else { "Disable" })
                .accessibility_label(format!(
                    "{} {}",
                    if row.disabled { "Enable" } else { "Disable" },
                    row.name
                ))
                .small()
                .on_click(move |_, _, _| toggle.set_disabled(&id2, !disabled)),
        )
    }

    fn agents(&self, c: &Colors) -> impl IntoElement {
        let mut section = section("Agents", c);
        for agent in &self.snapshot.agents {
            let (state, connected) = view::agent_line(agent);
            let (app, id) = (self.app.clone(), agent.id);
            section = section.child(
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .w(px(140.))
                            .flex_shrink_0()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(agent.title),
                    )
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_color(if connected { c.good } else { c.muted })
                            .child(state),
                    )
                    .child(
                        Button::new(SharedString::from(format!("agent-{id}")))
                            .label(if connected { "Disconnect" } else { "Connect" })
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
        section
    }

    fn background(&self, c: &Colors) -> impl IntoElement {
        let (state, can_install) = view::service_line(self.snapshot.service.as_ref());
        let app = self.app.clone();
        let mut line = h_flex()
            .gap_3()
            .child(
                div()
                    .w(px(220.))
                    .flex_shrink_0()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.snapshot.address.clone()),
            )
            .child(div().flex_1().text_color(c.muted).child(state));
        if can_install {
            line = line.child(
                Button::new("install-service")
                    .label("Start at login")
                    .on_click(move |_, _, _| app.install_service()),
            );
        }
        section("Background", c).child(line)
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
            .text_sm()
            .child(self.header(&c))
            .child(
                div().flex_1().min_h_0().child(
                    v_flex()
                        .id("body")
                        .size_full()
                        .p_5()
                        .gap_4()
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
    border: Hsla,
    track: Hsla,
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
            border: theme.border,
            track: theme.muted,
            good: theme.success,
            warn: theme.warning,
            bad: theme.danger,
            accent: rgb(0xdb2777).into(),
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

fn section(title: &str, c: &Colors) -> Div {
    v_flex()
        .gap_2p5()
        .p_4()
        .rounded_lg()
        .border_1()
        .border_color(c.border)
        .child(caption(title, c))
}

fn caption(text: &str, c: &Colors) -> Div {
    div()
        .text_xs()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.muted)
        .child(text.to_uppercase())
}

fn label(label: &Label, c: &Colors) -> Div {
    div()
        .text_color(c.tone(label.tone))
        .child(label.text.clone())
}

fn gauge(gauge: Option<&Gauge>, c: &Colors) -> Div {
    let cell = h_flex().w(px(190.)).flex_shrink_0().gap_2();
    let Some(g) = gauge else {
        return cell.child(div().text_color(c.muted).child("—"));
    };
    let color = c.tone(g.tone);
    cell.child(
        div()
            .w(px(110.))
            .h(px(7.))
            .rounded_full()
            .bg(c.track)
            .child(
                div()
                    .h_full()
                    .w(relative(g.fraction))
                    .rounded_full()
                    .bg(color),
            ),
    )
    .child(
        div()
            .w(px(38.))
            .flex()
            .justify_end()
            .text_xs()
            .text_color(color)
            .child(g.percent.clone()),
    )
    .child(
        div()
            .text_xs()
            .text_color(c.muted)
            .child(g.resets_in.clone().unwrap_or_default()),
    )
}
