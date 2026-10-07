//! The Agents page, which points Claude Code and Codex at slopmax, and the
//! Settings page: how the window looks, the proxy and starting at login,
//! adding accounts, and when reset credits are redeemed. Each is a card
//! of rows, a setting's name and what it does on the left, its control on
//! the right.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Disableable, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::Proxy;
use slopmax_app::view;
use slopmax_core::config::Config;
use slopmax_core::daemon::CREDIT_EXPIRY_LEAD;
use slopmax_core::provider::ProviderId;

use crate::prefs::{Appearance, Prefs};
use crate::theme::{self, Colors};
use crate::ui::{self, caption, card, icon_tile, pill, segmented};
use crate::{KEYS, Main, field, push};

impl Main {
    pub(crate) fn agents(&self, c: &Colors) -> Div {
        let mut cards = h_flex().flex_wrap().items_start().gap(px(16.));
        for agent in &self.snapshot.agents {
            let (state, connected) = view::agent_line(agent);
            let (app, id) = (self.app.clone(), agent.id);
            let color = match agent.title {
                "Claude Code" => c.provider(ProviderId::Claude),
                "Codex" => c.provider(ProviderId::Codex),
                _ => c.accent,
            };
            let verb = if connected { "Disconnect" } else { "Connect" };
            let button = Button::new(SharedString::from(format!("agent-{id}")))
                .label(verb)
                .small()
                .accessibility_label(format!("{verb} {}", agent.title))
                .map(|button| {
                    if connected {
                        button.outline().icon(IconName::Unplug)
                    } else {
                        button.primary().icon(IconName::Plug)
                    }
                })
                .on_click(move |_, _, _| {
                    if connected {
                        app.disconnect_agent(id);
                    } else {
                        app.connect_agent(id);
                    }
                });
            cards = cards.child(
                card(c)
                    .flex_1()
                    .min_w(px(300.))
                    .child(
                        h_flex()
                            .gap(px(12.))
                            .child(icon_tile(IconName::SquareTerminal, color, 36., c))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(px(ui::HEADING + 1.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(agent.title),
                                    )
                                    .child(caption(state, c).truncate()),
                            ),
                    )
                    .child(
                        h_flex()
                            .pt(px(14.))
                            .border_t_1()
                            .border_color(c.separator)
                            .child(if connected {
                                pill("Connected", c.good, c)
                            } else {
                                pill("Not connected", c.muted, c)
                            })
                            .child(div().flex_1())
                            .child(button),
                    ),
            );
        }
        v_flex()
            .gap(px(16.))
            .child(caption(
                "Connecting points an agent's own settings at slopmax, so its requests share \
                 your accounts; disconnecting puts back what was there.",
                c,
            ))
            .child(cards)
    }

    pub(crate) fn settings(&self, c: &Colors, cx: &mut Context<Self>) -> Div {
        v_flex()
            .max_w(px(860.))
            .gap(px(20.))
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
        let status = match &self.snapshot.proxy {
            Proxy::Running { version } => pill(format!("Running {version}"), c.good, c),
            Proxy::Starting => pill("Starting…", c.warn, c),
            Proxy::Checking => pill("Looking for it…", c.muted, c),
            Proxy::Stopped => pill("Stopped", c.bad, c),
        };
        let copy = address.clone();
        group(
            IconName::Server,
            c.accent,
            "Proxy",
            "What your agents talk to",
            c,
        )
        .child(row(
            "Status",
            "slopmax serves your agents while it runs.",
            h_flex().gap(px(10.)).child(status).child(
                Button::new("proxy")
                    .label(if running { "Stop" } else { "Start" })
                    .icon(IconName::Power)
                    .small()
                    .map(|b| if running { b.outline() } else { b.primary() })
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
        .child(row(
            "Address for agents",
            "Where an agent sends its requests.",
            h_flex()
                .gap(px(8.))
                .child(
                    div()
                        .px(px(10.))
                        .py(px(5.))
                        .rounded(px(7.))
                        .bg(c.well)
                        .border_1()
                        .border_color(c.border)
                        .text_size(px(12.5))
                        .font_family(mono())
                        .child(address),
                )
                .child(push("copy-address", "Copy").icon(IconName::Copy).on_click(
                    move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                    },
                )),
            c,
        ))
        .child(row(
            "Web dashboard",
            "The same at a glance, in your browser.",
            push("dashboard", "Open")
                .icon(IconName::ExternalLink)
                .disabled(!running)
                .on_click(move |_, _, _| dashboard.open_dashboard()),
            c,
        ))
        .child(row(
            "Start at login",
            state,
            div().children(can_install.then(|| {
                push("install-service", "Start at login")
                    .icon(IconName::Power)
                    .on_click(move |_, _, _| service.install_service())
            })),
            c,
        ))
    }

    /// Ways to add an account: signing in, importing, or an API key.
    fn adding(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let (claude, chatgpt, import) = (self.app.clone(), self.app.clone(), self.app.clone());
        let (app, key, provider) = (self.app.clone(), self.key.clone(), self.key_provider);
        group(
            IconName::Users,
            c.violet,
            "Add an account",
            "Subscriptions to pool, or keys billed by the token",
            c,
        )
        .child(row(
            "Sign in",
            "With your browser, as the agent's own sign-in does.",
            h_flex()
                .gap(px(8.))
                .child(
                    push("sign-in-claude", "Claude")
                        .icon(IconName::LogIn)
                        .on_click(move |_, _, _| claude.sign_in(ProviderId::Claude)),
                )
                .child(
                    push("sign-in-chatgpt", "ChatGPT")
                        .icon(IconName::LogIn)
                        .on_click(move |_, _, _| chatgpt.sign_in(ProviderId::Codex)),
                ),
            c,
        ))
        .child(row(
            "Import",
            "Logins Claude Code, Codex, or CLIProxyAPI already have.",
            push("import", "Import")
                .icon(IconName::Download)
                .on_click(move |_, _, _| import.import()),
            c,
        ))
        .child(
            v_flex()
                .py(px(14.))
                .gap(px(12.))
                .border_t_1()
                .border_color(c.separator)
                .child(label_block(
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
                        .child(
                            Button::new("add-key")
                                .label("Add key")
                                .icon(IconName::KeyRound)
                                .primary()
                                .small()
                                .on_click(move |_, window, cx| {
                                    let value = key.read(cx).value().to_string();
                                    if !value.is_empty() {
                                        app.add_key(provider, value);
                                        key.update(cx, |input, cx| input.set_value("", window, cx));
                                    }
                                }),
                        ),
                ),
        )
    }
}

/// The system's monospaced family, for an address.
fn mono() -> &'static str {
    if cfg!(target_os = "macos") {
        "Menlo"
    } else if cfg!(target_os = "windows") {
        "Consolas"
    } else {
        "DejaVu Sans Mono"
    }
}

/// Light or dark, or as the system has it.
fn appearance(c: &Colors, cx: &mut Context<Main>) -> impl IntoElement {
    let chosen = cx.global::<Prefs>().appearance;
    group(
        IconName::Sun,
        c.warn,
        "Appearance",
        "How slopmax looks, on every system alike",
        c,
    )
    .child(row(
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
    ))
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
        if on {
            pill("On", c.good, c)
        } else {
            pill("Off", c.muted, c)
        }
    };
    group(
        IconName::RotateCcw,
        c.good,
        "Reset credits",
        "Set in config.toml: redeem_expiring_credits and redeem_when_exhausted",
        c,
    )
    .child(row("When one would expire unused", expiring, state(on), c))
    .child(row(
        "When every account is spent",
        exhausted,
        state(spent),
        c,
    ))
}

/// A card of settings: its icon, title and what it covers, over its rows.
fn group(name: IconName, color: Hsla, title: &str, detail: &str, c: &Colors) -> Div {
    card(c).gap(px(4.)).child(
        h_flex()
            .gap(px(12.))
            .pb(px(10.))
            .child(icon_tile(name, color, 34., c))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(ui::HEADING + 1.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title.to_owned()),
                    )
                    .child(caption(detail, c)),
            ),
    )
}

/// A setting's name over what it does.
fn label_block(title: &str, detail: impl AsRef<str>, c: &Colors) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(2.))
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(c.fg)
                .child(title.to_owned()),
        )
        .child(caption(detail, c))
}

/// A row of a settings card: the setting, what it does, and its control.
fn row(title: &str, detail: impl AsRef<str>, control: impl IntoElement, c: &Colors) -> Div {
    h_flex()
        .min_h(px(60.))
        .py(px(12.))
        .gap(px(16.))
        .border_t_1()
        .border_color(c.separator)
        .child(label_block(title, detail, c))
        .child(div().flex_shrink_0().child(control))
}
