//! The Agents page, which points Claude Code and Codex at slopmax, and the
//! Settings page, a grouped form as System Settings draws one: the proxy
//! and starting at login, adding accounts, and when reset credits are
//! redeemed.

use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::Proxy;
use slopmax_app::view::{self, Label};
use slopmax_core::config::Config;
use slopmax_core::daemon::CREDIT_EXPIRY_LEAD;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;

use crate::{Colors, KEYS, Main, caption, dot, field, group_box, label, push, section};

/// The width of a form row's title.
const TITLE: Pixels = px(190.);

impl Main {
    pub(crate) fn agents(&self, c: &Colors) -> Div {
        let mut list = group_box(c);
        for (i, agent) in self.snapshot.agents.iter().enumerate() {
            let (state, connected) = view::agent_line(agent);
            let (app, id) = (self.app.clone(), agent.id);
            list = list.child(
                h_flex()
                    .py(px(10.))
                    .gap(px(12.))
                    .when(i > 0, |row| row.border_t_1().border_color(c.separator))
                    .child(
                        div()
                            .w(px(140.))
                            .flex_shrink_0()
                            .font_weight(FontWeight::MEDIUM)
                            .child(agent.title),
                    )
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
        v_flex().gap(px(8.)).child(list).child(
            caption(
                "Connecting points an agent's own settings at slopmax, so its requests \
                 share your accounts; disconnecting puts back what was there.",
                c,
            )
            .px(px(4.)),
        )
    }

    pub(crate) fn settings(&self, c: &Colors, cx: &mut Context<Self>) -> Div {
        v_flex()
            .gap(px(26.))
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
        let status = h_flex()
            .gap(px(6.))
            .child(dot(if running { c.good } else { c.muted }))
            .child(match &self.snapshot.proxy {
                Proxy::Running { version } => format!("Running {version}"),
                Proxy::Starting => "Starting…".to_owned(),
                Proxy::Checking => "Looking for it…".to_owned(),
                Proxy::Stopped => "Stopped".to_owned(),
            });
        section("Proxy", c).child(
            group_box(c)
                .child(row(
                    "Status",
                    status,
                    Some(
                        push("proxy", if running { "Stop Proxy" } else { "Start Proxy" })
                            .on_click(move |_, _, _| {
                                if running {
                                    start.stop_proxy();
                                } else {
                                    start.start_proxy();
                                }
                            })
                            .into_any_element(),
                    ),
                    true,
                    c,
                ))
                .child(row(
                    "Address for agents",
                    div().child(address.clone()),
                    Some(
                        push("copy-address", "Copy")
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(address.clone()));
                            })
                            .into_any_element(),
                    ),
                    false,
                    c,
                ))
                .child(row(
                    "Web dashboard",
                    div().text_color(c.muted).child("In your browser"),
                    Some(
                        push("dashboard", "Open")
                            .disabled(!running)
                            .on_click(move |_, _, _| dashboard.open_dashboard())
                            .into_any_element(),
                    ),
                    false,
                    c,
                ))
                .child(row(
                    "Start at login",
                    div().text_color(c.muted).child(state),
                    can_install.then(|| {
                        push("install-service", "Start at Login")
                            .on_click(move |_, _, _| service.install_service())
                            .into_any_element()
                    }),
                    false,
                    c,
                )),
        )
    }

    /// Ways to add an account: signing in, importing, or an API key.
    fn adding(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let (claude, chatgpt, import) = (self.app.clone(), self.app.clone(), self.app.clone());
        let (app, key, provider) = (self.app.clone(), self.key.clone(), self.key_provider);
        section("Add an account", c).child(
            group_box(c)
                .child(row(
                    "Sign in",
                    h_flex()
                        .gap(px(8.))
                        .child(
                            push("sign-in-claude", "Sign In with Claude…")
                                .on_click(move |_, _, _| claude.sign_in(ProviderId::Claude)),
                        )
                        .child(
                            push("sign-in-chatgpt", "Sign In with ChatGPT…")
                                .on_click(move |_, _, _| chatgpt.sign_in(ProviderId::Codex)),
                        ),
                    None,
                    true,
                    c,
                ))
                .child(row(
                    "Import",
                    div()
                        .text_color(c.muted)
                        .child("Logins Claude Code, Codex, or CLIProxyAPI already have"),
                    Some(
                        push("import", "Import")
                            .on_click(move |_, _, _| import.import())
                            .into_any_element(),
                    ),
                    false,
                    c,
                ))
                .child(row(
                    "API key",
                    h_flex()
                        .gap(px(8.))
                        .child(self.segmented(
                            "key",
                            KEYS.map(|provider| (provider, provider.spec().title)),
                            self.key_provider,
                            |main, provider, cx| {
                                main.key_provider = provider;
                                cx.notify();
                            },
                            c,
                            cx,
                        ))
                        .child(div().flex_1().child(field(&self.key))),
                    Some(
                        push("add-key", "Add Key")
                            .on_click(move |_, window, cx| {
                                let value = key.read(cx).value().to_string();
                                if !value.is_empty() {
                                    app.add_key(provider, value);
                                    key.update(cx, |input, cx| input.set_value("", window, cx));
                                }
                            })
                            .into_any_element(),
                    ),
                    false,
                    c,
                )),
        )
    }
}

/// When slopmax redeems a reset credit by itself, as its configuration has
/// it.
fn redeeming(config: &Config, c: &Colors) -> impl IntoElement {
    let lead = CREDIT_EXPIRY_LEAD.as_secs() / 3_600;
    let expiring = if config.redeem_expiring_credits {
        format!("Redeemed {lead} hours before, if the account has quota to reset")
    } else {
        "Left to expire".to_owned()
    };
    let exhausted = if config.redeem_when_exhausted {
        "One is redeemed, so the pool keeps serving"
    } else {
        "None are redeemed; the pool waits for a reset"
    };
    v_flex()
        .gap(px(8.))
        .child(
            section("Reset credits", c).child(
                group_box(c)
                    .child(row(
                        "When one would expire unused",
                        div().text_color(c.muted).child(expiring),
                        None,
                        true,
                        c,
                    ))
                    .child(row(
                        "When every account is spent",
                        div().text_color(c.muted).child(exhausted),
                        None,
                        false,
                        c,
                    )),
            ),
        )
        .child(
            caption(
                "Set in slopmax's config.toml: redeem_expiring_credits and redeem_when_exhausted.",
                c,
            )
            .px(px(4.)),
        )
}

/// A row of a grouped form: its title, its value, and a control.
fn row(
    title: &str,
    value: impl IntoElement,
    control: Option<AnyElement>,
    first: bool,
    c: &Colors,
) -> Div {
    h_flex()
        .min_h(px(44.))
        .py(px(8.))
        .gap(px(12.))
        .when(!first, |row| row.border_t_1().border_color(c.separator))
        .child(div().w(TITLE).flex_shrink_0().child(title.to_owned()))
        .child(div().flex_1().min_w_0().child(value))
        .children(control)
}
