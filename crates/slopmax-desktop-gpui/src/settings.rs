//! The Agents page, which points Claude Code and Codex at slopmax, and the
//! Settings page: how the window looks, the proxy and starting at login,
//! how requests find their account, when reset credits are redeemed,
//! notifications, and the rest of what changes while the proxy runs. Each
//! is a titled panel of rows: a setting's name and what it does on the
//! left, its control on the right.

use std::sync::Arc;

use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::view::{self, Label};
use slopmax_app::{App as Slopmax, Proxy, Setting};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::report::Tone;

use crate::Main;
use crate::prefs::{Appearance, Prefs};
use crate::theme::{self, Colors, tabular};
use crate::ui::{self, caption, label, panel, push, section, segmented};

impl Main {
    pub(crate) fn agents(&self, c: &Colors) -> Div {
        let mut list = panel(c);
        for (i, agent) in self.snapshot.agents.iter().enumerate() {
            let (state, connected) = view::agent_line(agent);
            let (app, id) = (self.app.clone(), agent.id);
            let verb = if connected { "Disconnect" } else { "Connect" };
            let button = push(SharedString::from(format!("agent-{id}")), verb)
                .accessibility_label(format!("{verb} {}", agent.title))
                .on_click(move |_, _, _| {
                    if connected {
                        app.disconnect_agent(id);
                    } else {
                        app.connect_agent(id);
                    }
                });
            let standing = Label {
                text: if connected {
                    "Connected"
                } else {
                    "Not connected"
                }
                .to_owned(),
                tone: if connected { Tone::Good } else { Tone::Muted },
            };
            list = list.child(setting(
                i == 0,
                agent.title,
                state,
                h_flex()
                    .gap(px(16.))
                    .child(label(&standing, c))
                    .child(button),
                c,
            ));
        }
        v_flex()
            .gap(px(16.))
            .child(div().max_w(px(560.)).text_color(c.muted).child(
                "Connecting points an agent's own settings at slopmax, so its requests share \
                 your accounts. Disconnecting puts back what was there.",
            ))
            .child(list)
    }

    pub(crate) fn settings(&self, c: &Colors, cx: &mut Context<Self>) -> Div {
        v_flex()
            .gap(px(32.))
            .child(appearance(c, cx))
            .child(self.proxy(c))
            .child(routing(&self.app, &self.snapshot.config, c))
            .child(redeeming(&self.app, &self.snapshot.config, c))
            .child(notifications(&self.app, self.snapshot.notifications, c))
            .child(advanced(&self.app, &self.snapshot.config, c))
    }

    /// The proxy: whether it runs, where agents reach it, its dashboard,
    /// and whether it starts at login.
    fn proxy(&self, c: &Colors) -> impl IntoElement {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let (start, dashboard, service) = (self.app.clone(), self.app.clone(), self.app.clone());
        let address = self.snapshot.address.clone();
        let login = view::login(self.snapshot.service.as_ref());
        let (text, tone) = match &self.snapshot.proxy {
            Proxy::Running { version } => (format!("Running {version}"), Tone::Good),
            Proxy::Starting => ("Starting…".to_owned(), Tone::Muted),
            Proxy::Checking => ("Looking for it…".to_owned(), Tone::Muted),
            Proxy::Stopped => ("Stopped".to_owned(), Tone::Bad),
        };
        let copy = address.clone();
        section("Proxy", None, c).child(
            panel(c)
                .child(setting(
                    true,
                    "Status",
                    "slopmax serves your agents while it runs.",
                    h_flex()
                        .gap(px(16.))
                        .child(label(&Label { text, tone }, c))
                        .child(
                            push("proxy", if running { "Stop" } else { "Start" })
                                .map(|b| if running { b } else { b.primary() })
                                .on_click(move |_, _, _| {
                                    if running {
                                        start.stop_proxy();
                                    } else {
                                        start.start_proxy();
                                    }
                                }),
                        ),
                    c,
                ))
                .child(setting(
                    false,
                    "Address for agents",
                    "Where an agent sends its requests.",
                    h_flex()
                        .gap(px(8.))
                        .child(
                            h_flex()
                                .h(px(ui::CONTROL))
                                .px(px(10.))
                                .rounded(px(6.))
                                .bg(c.well)
                                .border_1()
                                .border_color(c.border)
                                .font_features(tabular())
                                .child(address),
                        )
                        .child(push("copy-address", "Copy").on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                        })),
                    c,
                ))
                .child(setting(
                    false,
                    "Web dashboard",
                    "The same at a glance, in your browser.",
                    push("dashboard", "Open in browser")
                        .disabled(!running)
                        .on_click(move |_, _, _| dashboard.open_dashboard()),
                    c,
                ))
                .child(setting(
                    false,
                    "Start at login",
                    login.detail,
                    Switch::new("start-at-login")
                        .checked(login.on)
                        .disabled(!login.available)
                        .accessibility_label("Start at login")
                        .on_click(move |on, _, _| {
                            if *on {
                                service.install_service();
                            } else {
                                service.uninstall_service();
                            }
                        }),
                    c,
                )),
        )
    }
}

/// Light or dark, or as the system has it.
fn appearance(c: &Colors, cx: &mut Context<Main>) -> impl IntoElement {
    let chosen = cx.global::<Prefs>().appearance;
    section("Appearance", None, c).child(panel(c).child(setting(
        true,
        "Theme",
        "Follow the system, or keep to light or dark.",
        segmented(
            "appearance",
            Appearance::ALL.map(|appearance| (appearance, appearance.title())),
            chosen,
            |_: &mut Main, appearance, cx| {
                let prefs = cx.global_mut::<Prefs>();
                prefs.appearance = appearance;
                prefs.save();
                theme::refresh(cx);
            },
            c,
            cx,
        ),
        c,
    )))
}

/// How a request finds its account: the strategy that places a new
/// session, and whether a session keeps the account it started on.
fn routing(app: &Arc<Slopmax>, config: &Config, c: &Colors) -> impl IntoElement {
    let mut strategies = panel(c);
    for (i, strategy) in Strategy::ALL.into_iter().enumerate() {
        strategies = strategies.child(choice(
            app,
            strategy,
            config.strategy == strategy,
            i == 0,
            c,
        ));
    }
    section("Routing", None, c)
        .child(strategies)
        .child(panel(c).child(setting(
            true,
            "Session affinity",
            view::AFFINITY,
            toggle(
                app,
                "session-affinity",
                "Session affinity",
                config.session_affinity,
                Setting::SessionAffinity,
            ),
            c,
        )))
        .child(caption(view::AFFINITY_HEADER, c))
}

/// A strategy to choose, as a row that chooses it when pressed: a radio,
/// its name, and what it does.
fn choice(
    app: &Arc<Slopmax>,
    strategy: Strategy,
    chosen: bool,
    first: bool,
    c: &Colors,
) -> impl IntoElement {
    let title = view::strategy_title(strategy);
    let app = app.clone();
    let hover = c.hover;
    let radio = div()
        .flex_shrink_0()
        .size(px(16.))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .map(|radio| {
            if chosen {
                radio
                    .bg(c.fg)
                    .child(div().size(px(6.)).rounded_full().bg(c.bg))
            } else {
                radio.border_1().border_color(c.faint)
            }
        });
    ui::row(first, c)
        .id(SharedString::from(format!("strategy-{strategy}")))
        .min_h(px(60.))
        .when(first, |row| row.rounded_t(px(7.)))
        .when(!chosen, |row| {
            row.cursor_pointer().hover(move |row| row.bg(hover))
        })
        .role(Role::RadioButton)
        .aria_label(title)
        .aria_selected(chosen)
        .child(radio)
        .child(name(title, view::strategy_detail(strategy), c))
        .on_click(move |_, _, _| {
            if !chosen {
                app.set(Setting::Strategy(strategy));
            }
        })
}

/// A switch for a setting that is on or off.
fn toggle(
    app: &Arc<Slopmax>,
    id: &'static str,
    title: &'static str,
    on: bool,
    setting: fn(bool) -> Setting,
) -> impl IntoElement {
    let app = app.clone();
    Switch::new(id)
        .checked(on)
        .accessibility_label(title)
        .on_click(move |on, _, _| app.set(setting(*on)))
}

/// When slopmax redeems a reset credit by itself.
fn redeeming(app: &Arc<Slopmax>, config: &Config, c: &Colors) -> impl IntoElement {
    let (expiring, exhausted) = (
        "When one would expire unused",
        "When every account is spent",
    );
    section("Limit resets", None, c).child(
        panel(c)
            .child(setting(
                true,
                expiring,
                view::redeem_expiring_detail(),
                toggle(
                    app,
                    "redeem-expiring",
                    expiring,
                    config.redeem_expiring_credits,
                    Setting::RedeemExpiringCredits,
                ),
                c,
            ))
            .child(setting(
                false,
                exhausted,
                view::REDEEM_EXHAUSTED,
                toggle(
                    app,
                    "redeem-exhausted",
                    exhausted,
                    config.redeem_when_exhausted,
                    Setting::RedeemWhenExhausted,
                ),
                c,
            )),
    )
}

/// Whether slopmax tells you, in a notification, of a limit reset about to
/// lapse or a week about to reset with quota to spare. A copy outside the
/// installed app cannot post them, and says so.
fn notifications(app: &Arc<Slopmax>, on: bool, c: &Colors) -> impl IntoElement {
    let app = app.clone();
    let unavailable = crate::notifications::unavailable();
    section("Notifications", None, c).child(
        panel(c).child(setting(
            true,
            "Notify me",
            unavailable.unwrap_or(
                "When a limit reset is about to lapse unredeemed, or a week is about to reset with \
             quota to spare.",
            ),
            Switch::new("notifications")
                .checked(on && unavailable.is_none())
                .disabled(unavailable.is_some())
                .accessibility_label("Notifications")
                .on_click(move |on, _, _| app.set_notifications(*on)),
            c,
        )),
    )
}

/// The rest of what can change while the proxy runs, as `slopmax config`
/// changes it.
fn advanced(app: &Arc<Slopmax>, config: &Config, c: &Colors) -> impl IntoElement {
    let minutes = |name: &'static str,
                   title: &'static str,
                   steps: &'static [u64],
                   current: u64,
                   show: fn(u64) -> String,
                   setting: fn(u64) -> Setting| {
        let press = |up: bool| -> ui::Press {
            let next = view::step(steps, current, up)?;
            let app = app.clone();
            Some(Box::new(move |_: &mut App| app.set(setting(next))))
        };
        ui::stepper(name, title, show(current), press(false), press(true), c)
    };
    section("Advanced", None, c)
        .child(
            panel(c)
                .child(setting(
                    true,
                    "Session timeout",
                    view::live_detail("session_ttl_mins"),
                    minutes(
                        "session-ttl",
                        "session timeout",
                        view::SESSION_TTL_STEPS,
                        config.session_ttl_mins,
                        view::minutes,
                        Setting::SessionTtlMins,
                    ),
                    c,
                ))
                .child(setting(
                    false,
                    "Usage polling",
                    view::live_detail("poll_mins"),
                    minutes(
                        "poll",
                        "usage polling",
                        view::POLL_STEPS,
                        config.poll_mins,
                        |mins| match mins {
                            0 => "Off".to_owned(),
                            mins => view::minutes(mins),
                        },
                        Setting::PollMins,
                    ),
                    c,
                ))
                .child(setting(
                    false,
                    "Warm ChatGPT windows",
                    view::live_detail("warm_windows"),
                    toggle(
                        app,
                        "warm-windows",
                        "Warm ChatGPT windows",
                        config.warm_windows,
                        Setting::WarmWindows,
                    ),
                    c,
                ))
                .child(setting(
                    false,
                    "Overflow to API keys",
                    view::live_detail("paid_overflow"),
                    toggle(
                        app,
                        "paid-overflow",
                        "Overflow to API keys",
                        config.paid_overflow,
                        Setting::PaidOverflow,
                    ),
                    c,
                )),
        )
        .child(caption(
            "Each is saved to config.toml and applied at once; slopmax config changes them too.",
            c,
        ))
}

/// A setting's name over what it does.
pub(crate) fn name(title: &str, detail: impl AsRef<str>, c: &Colors) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(2.))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .text_color(c.fg)
                .child(title.to_owned()),
        )
        .child(caption(detail, c))
}

/// A row of settings: the setting, what it does, and its control.
pub(crate) fn setting(
    first: bool,
    title: &str,
    detail: impl AsRef<str>,
    control: impl IntoElement,
    c: &Colors,
) -> Div {
    ui::row(first, c)
        .min_h(px(60.))
        .child(name(title, detail, c))
        .child(div().flex_shrink_0().child(control))
}
