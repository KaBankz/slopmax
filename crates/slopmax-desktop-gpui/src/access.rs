//! The Access page, every way in and out: adding an account (signing in,
//! importing, an API key, or a compatible endpoint), and client keys for
//! other machines and tools, the new one shown once. And the Diagnostics
//! page, the setup checks `slopmax doctor` runs, each with its fix to copy.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::input::InputState;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::view;
use slopmax_app::{Doctor, NewEndpoint};
use slopmax_core::wire::Dialect;

use slopmax_core::provider::ProviderId;

use crate::settings::{name, setting};
use crate::theme::{Colors, MONO};
use crate::ui::{self, caption, dot, field, panel, push, section, segmented, tool};
use crate::{KEYS, Main};

/// The APIs a compatible endpoint may speak.
const DIALECTS: [(Dialect, &str); 3] = [
    (Dialect::Chat, "Chat completions"),
    (Dialect::Responses, "Responses"),
    (Dialect::Messages, "Messages"),
];

/// The page's text fields.
pub(crate) struct Fields {
    key_name: Entity<InputState>,
    key_models: Entity<InputState>,
    url: Entity<InputState>,
    models: Entity<InputState>,
    key: Entity<InputState>,
    label: Entity<InputState>,
    dialect: Dialect,
    /// The client key whose revoking waits on a second press.
    revoking: Option<String>,
}

impl Fields {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Main>) -> Self {
        let mut input = |placeholder: &'static str, masked: bool| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .masked(masked)
            })
        };
        Self {
            key_name: input("Name, such as laptop", false),
            key_models: input("Models it may use, as patterns (any if empty)", false),
            url: input("https://example.com/v1", false),
            models: input("Models it serves, as patterns (any if empty)", false),
            key: input("Its API key", true),
            label: input("Name (optional)", false),
            dialect: Dialect::Chat,
            revoking: None,
        }
    }
}

/// A field's text, and clears it.
fn take(state: &Entity<InputState>, window: &mut Window, cx: &mut App) -> String {
    let text = state.read(cx).value().trim().to_owned();
    state.update(cx, |input, cx| input.set_value("", window, cx));
    text
}

impl Main {
    pub(crate) fn access(&self, c: &Colors, cx: &mut Context<Self>) -> Div {
        v_flex()
            .gap(px(32.))
            .child(div().max_w(px(560.)).text_color(c.muted).child(
                "The accounts slopmax sends requests to, and the keys other machines and \
                 tools reach it with.",
            ))
            .child(self.adding(c, cx))
            .child(self.client_keys(c, cx))
    }

    /// Ways to add an account, in one place: signing in, importing, an API
    /// key, or a compatible endpoint.
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
                )
                .child(self.endpoint(c, cx)),
        )
    }

    /// The client keys: each by name and the models it may use, the one
    /// just made shown once, and a row to make another.
    fn client_keys(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let mut list = panel(c);
        let mut first = true;
        if let Some(new) = &self.snapshot.new_key {
            let (key, app) = (new.key.clone(), self.app.clone());
            list = list.child(
                ui::row(true, c)
                    .bg(c.well)
                    .rounded_t(px(7.))
                    .flex_col()
                    .items_stretch()
                    .gap(px(10.))
                    .child(
                        v_flex()
                            .gap(px(2.))
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!("The key {}", new.name)),
                            )
                            .child(caption(
                                "Copy it now: you won't see it again. Give it to the tool as \
                                 its API key, with slopmax's address.",
                                c,
                            )),
                    )
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .child(
                                h_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .h(px(ui::CONTROL))
                                    .px(px(10.))
                                    .rounded(px(6.))
                                    .bg(c.bg)
                                    .border_1()
                                    .border_color(c.border)
                                    .font_family(MONO)
                                    .text_size(px(ui::SMALL))
                                    .child(div().truncate().child(new.key.clone())),
                            )
                            .child(push("copy-new-key", "Copy").primary().on_click(
                                move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(key.clone()));
                                },
                            ))
                            .child(
                                push("done-new-key", "Done")
                                    .on_click(move |_, _, _| app.dismiss_new_key()),
                            ),
                    ),
            );
            first = false;
        }
        for (i, key) in self.snapshot.config.keys.iter().enumerate() {
            let models = if key.models.is_empty() {
                "Any model".to_owned()
            } else {
                key.models.join(", ")
            };
            let confirming = self.access.revoking.as_deref() == Some(key.name.as_str());
            let name = key.name.clone();
            let action = if confirming {
                let app = self.app.clone();
                h_flex()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(ui::SMALL))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Revoke it?"),
                    )
                    .child(
                        push(SharedString::from(format!("keep-key-{i}")), "Cancel").on_click(
                            cx.listener(|main, _, _, cx| {
                                main.access.revoking = None;
                                cx.notify();
                            }),
                        ),
                    )
                    .child(
                        push(SharedString::from(format!("revoke-key-{i}")), "Revoke")
                            .primary()
                            .accessibility_label(format!("Revoke the key {name}"))
                            .on_click(cx.listener(move |main, _, _, cx| {
                                main.access.revoking = None;
                                app.revoke_key(&name);
                                cx.notify();
                            })),
                    )
            } else {
                h_flex().child(
                    push(SharedString::from(format!("ask-revoke-{i}")), "Revoke…")
                        .accessibility_label(format!("Revoke the key {}…", key.name))
                        .on_click(cx.listener(move |main, _, _, cx| {
                            main.access.revoking = Some(name.clone());
                            cx.notify();
                        })),
                )
            };
            list = list.child(
                ui::row(first, c)
                    .min_h(px(60.))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(key.name.clone()),
                            )
                            .child(
                                caption(models, c)
                                    .when(!key.models.is_empty(), |line| line.font_family(MONO)),
                            ),
                    )
                    .child(action),
            );
            first = false;
        }
        let (app, fields) = (
            self.app.clone(),
            (self.access.key_name.clone(), self.access.key_models.clone()),
        );
        list =
            list.child(
                ui::row(first, c)
                    .gap(px(8.))
                    .child(div().w(px(200.)).flex_shrink_0().child(field(&fields.0)))
                    .child(div().flex_1().min_w_0().child(field(&fields.1)))
                    .child(push("make-key", "Create key").primary().on_click(
                        move |_, window, cx| {
                            let name = fields.0.read(cx).value().trim().to_owned();
                            if name.is_empty() {
                                return;
                            }
                            let name = take(&fields.0, window, cx);
                            let models = view::patterns(&take(&fields.1, window, cx));
                            app.add_client_key(name, models);
                        },
                    )),
            );
        section("Client keys", None, c).child(list).child(caption(
            "A tool presents its key as an API key. Revoking one refuses it at once; slopmax's \
             own key, in config.toml, stays as it is.",
            c,
        ))
    }

    /// A compatible endpoint to add: where it is, the API it speaks, the
    /// models it serves, and its key.
    fn endpoint(&self, c: &Colors, cx: &mut Context<Self>) -> Div {
        let fields = &self.access;
        let (url, models, key, label) = (
            fields.url.clone(),
            fields.models.clone(),
            fields.key.clone(),
            fields.label.clone(),
        );
        let (app, dialect) = (self.app.clone(), fields.dialect);
        let line = |title: &'static str, control: AnyElement| {
            h_flex()
                .gap(px(16.))
                .child(
                    div()
                        .w(px(96.))
                        .flex_shrink_0()
                        .text_color(c.muted)
                        .child(title),
                )
                .child(div().flex_1().min_w_0().child(control))
        };
        ui::row(false, c)
            .flex_col()
            .items_stretch()
            .gap(px(12.))
            .child(
                v_flex()
                    .gap(px(2.))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Compatible endpoint"),
                    )
                    .child(caption(
                        "An API that speaks OpenAI's or Anthropic's format, such as a \
                                 local model server or a gateway. Its key is checked before it \
                                 is saved.",
                        c,
                    )),
            )
            .child(line("Address", field(&url).into_any_element()))
            .child(line(
                "API",
                h_flex()
                    .child(segmented(
                        "dialect",
                        DIALECTS,
                        dialect,
                        |main: &mut Main, dialect, cx| {
                            main.access.dialect = dialect;
                            cx.notify();
                        },
                        c,
                        cx,
                    ))
                    .into_any_element(),
            ))
            .child(line("Models", field(&models).into_any_element()))
            .child(line("Key", field(&key).into_any_element()))
            .child(line("Name", field(&label).into_any_element()))
            .child(
                h_flex().justify_end().child(
                    push("add-endpoint", "Add endpoint").primary().on_click(
                        move |_, window, cx| {
                            if url.read(cx).value().trim().is_empty() {
                                return;
                            }
                            let endpoint = NewEndpoint {
                                url: take(&url, window, cx),
                                dialect,
                                models: view::patterns(&take(&models, window, cx)),
                                key: take(&key, window, cx),
                                label: Some(take(&label, window, cx)).filter(|l| !l.is_empty()),
                            };
                            app.add_endpoint(endpoint);
                        },
                    ),
                ),
            )
    }

    /// The setup checks, in one card as the dashboard's health check has
    /// them: each part of the setup in a column at the left, beside its
    /// findings, a dot for how each stands, and the command that fixes it
    /// on a chip to copy.
    pub(crate) fn diagnostics(&self, c: &Colors) -> Div {
        let sections = match &self.snapshot.doctor {
            Doctor::NotRun | Doctor::Running => {
                return v_flex().child(ui::empty(
                    "Checking your setup…",
                    "The same checks slopmax doctor runs.",
                    c,
                ));
            }
            Doctor::Failed(error) => {
                return v_flex().child(ui::empty("Could not check the setup", error, c));
            }
            Doctor::Done(sections) => sections,
        };
        let mut card = panel(c);
        let mut first = true;
        for (s, part) in sections.iter().enumerate() {
            for (i, finding) in part.findings.iter().enumerate() {
                let tone = view::level_tone(finding.level);
                let fix = finding.fix.clone().map(|fix| {
                    let copy = fix.clone();
                    h_flex()
                        .gap(px(4.))
                        .child(
                            div()
                                .px(px(6.))
                                .py(px(1.))
                                .rounded(px(4.))
                                .bg(c.well)
                                .border_1()
                                .border_color(c.border)
                                .font_family(MONO)
                                .text_size(px(ui::SMALL))
                                .child(fix),
                        )
                        .child(
                            tool(
                                SharedString::from(format!("copy-fix-{s}-{i}")),
                                IconName::Copy,
                                "Copy the command",
                            )
                            .size(px(20.))
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                            }),
                        )
                });
                // Each part of the row as tall as a line, so the dot sits
                // by the first line of its finding; the fix in a column of
                // its own at the right.
                let line = px(20.);
                card = card.child(
                    ui::row(first, c)
                        .items_start()
                        .child(
                            div()
                                .w(px(120.))
                                .flex_shrink_0()
                                .min_h(line)
                                .flex()
                                .items_center()
                                .text_color(c.muted)
                                .when(i == 0, |label| label.child(part.title)),
                        )
                        .child(div().h(line).flex().items_center().child(dot(c.tone(tone))))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .line_height(line)
                                // The CLI's words, as a window sets them.
                                .child(ui::sentence(&finding.text.replace('`', ""))),
                        )
                        .children(fix.map(|fix| fix.flex_shrink_0().min_h(line))),
                );
                first = false;
            }
        }
        v_flex()
            .gap(px(16.))
            .child(
                div()
                    .max_w(px(560.))
                    .text_color(c.muted)
                    .child("The checks slopmax doctor runs, with what to do about each."),
            )
            .child(card)
    }
}
