//! The Agents page, which points Claude Code and Codex at slopmax, and the
//! Settings page: how the window looks, the proxy and starting at login,
//! adding accounts, and when reset credits are redeemed. Each is a titled
//! panel of rows: a setting's name and what it does on the left, its
//! control on the right.

use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::Proxy;
use slopmax_app::view::{self, Label};
use slopmax_core::config::Config;
use slopmax_core::daemon::CREDIT_EXPIRY_LEAD;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;

use crate::prefs::{Appearance, Prefs};
use crate::theme::{self, Colors, tabular};
use crate::ui::{self, caption, field, label, panel, push, section, segmented};
use crate::{KEYS, Main};

/// The widest these pages' panels grow, so a row's name and its control
/// stay within a glance of each other.
const WIDTH: f32 = 760.;

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
            .max_w(px(WIDTH))
            .gap(px(16.))
            .child(div().max_w(px(560.)).text_color(c.muted).child(
                "Connecting points an agent's own settings at slopmax, so its requests share \
                 your accounts. Disconnecting puts back what was there.",
            ))
            .child(list)
    }

    pub(crate) fn settings(&self, c: &Colors, cx: &mut Context<Self>) -> Div {
        v_flex()
            .max_w(px(WIDTH))
            .gap(px(32.))
            .child(appearance(c, cx))
            .child(self.proxy(c))
            .child(self.adding(c, cx))
            .child(redeeming(self.app.config(), c))
    }

    /// The proxy: whether it runs, where agents reach it, its dashboard,
    /// and whether it starts at login.
    fn proxy(&self, c: &Colors) -> impl IntoElement {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let (start, dashboard, service) = (self.app.clone(), self.app.clone(), self.app.clone());
        let address = self.snapshot.address.clone();
        let (state, can_install) = view::service_line(self.snapshot.service.as_ref());
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
                    state,
                    div().children(can_install.then(|| {
                        push("install-service", "Start at login")
                            .on_click(move |_, _, _| service.install_service())
                    })),
                    c,
                )),
        )
    }

    /// Ways to add an account: signing in, importing, or an API key.
    fn adding(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let (claude, chatgpt, import) = (self.app.clone(), self.app.clone(), self.app.clone());
        let (app, key, provider) = (self.app.clone(), self.key.clone(), self.key_provider);
        section("Add an account", None, c).child(
            panel(c)
                .child(setting(
                    true,
                    "Sign in",
                    "With your browser, as the agent's own sign-in does.",
                    h_flex()
                        .gap(px(8.))
                        .child(
                            push("sign-in-claude", "Claude")
                                .on_click(move |_, _, _| claude.sign_in(ProviderId::Claude)),
                        )
                        .child(
                            push("sign-in-chatgpt", "ChatGPT")
                                .on_click(move |_, _, _| chatgpt.sign_in(ProviderId::Codex)),
                        ),
                    c,
                ))
                .child(setting(
                    false,
                    "Import",
                    "Logins Claude Code, Codex, or CLIProxyAPI already have.",
                    push("import", "Import").on_click(move |_, _, _| import.import()),
                    c,
                ))
                .child(
                    ui::row(false, c)
                        .flex_col()
                        .items_stretch()
                        .gap(px(12.))
                        .child(name(
                            "API key",
                            "A key bills by the token; slopmax spends subscriptions first.",
                            c,
                        ))
                        .child(
                            h_flex()
                                .gap(px(8.))
                                .child(segmented(
                                    "key",
                                    KEYS.map(|provider| (provider, provider.spec().title)),
                                    self.key_provider,
                                    |main: &mut Main, provider, cx| {
                                        main.key_provider = provider;
                                        cx.notify();
                                    },
                                    c,
                                    cx,
                                ))
                                .child(div().flex_1().child(field(&self.key)))
                                .child(push("add-key", "Add key").primary().on_click(
                                    move |_, window, cx| {
                                        let value = key.read(cx).value().to_string();
                                        if !value.is_empty() {
                                            app.add_key(provider, value);
                                            key.update(cx, |input, cx| {
                                                input.set_value("", window, cx);
                                            });
                                        }
                                    },
                                )),
                        ),
                ),
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

/// When slopmax redeems a reset credit by itself, as its configuration has
/// it.
fn redeeming(config: &Config, c: &Colors) -> impl IntoElement {
    let lead = CREDIT_EXPIRY_LEAD.as_secs() / 3_600;
    let (expiring, on) = if config.redeem_expiring_credits {
        (
            format!("Redeemed {lead} hours before, if the account has quota to reset."),
            true,
        )
    } else {
        ("Left to expire.".to_owned(), false)
    };
    let (exhausted, spent) = if config.redeem_when_exhausted {
        ("One is redeemed, so the pool keeps serving.", true)
    } else {
        ("None are redeemed; the pool waits for a reset.", false)
    };
    let state = |on: bool| {
        div()
            .text_color(if on { c.fg } else { c.muted })
            .child(if on { "On" } else { "Off" })
    };
    section("Limit resets", None, c)
        .child(
            panel(c)
                .child(setting(
                    true,
                    "When one would expire unused",
                    expiring,
                    state(on),
                    c,
                ))
                .child(setting(
                    false,
                    "When every account is spent",
                    exhausted,
                    state(spent),
                    c,
                )),
        )
        .child(caption(
            "Set in config.toml, as redeem_expiring_credits and redeem_when_exhausted.",
            c,
        ))
}

/// A setting's name over what it does.
fn name(title: &str, detail: impl AsRef<str>, c: &Colors) -> Div {
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
fn setting(
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
