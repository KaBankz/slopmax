//! The pages about slopmax itself: the agents it serves, who may reach it,
//! what `slopmax doctor` finds, and the settings it changes while it runs.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use slopmax_client::api::Tone;
use slopmax_client::api::report::Level;
use slopmax_client::api::settings::{LIVE, LiveValue};
use slopmax_client::api::tailnet::{TailscaleState, Transport};

use super::widgets::{Flow, dot};
use crate::app::{App, Hit, setting_group, setting_title};
use crate::data::Slot;
use crate::format::{self, Now};

/// What a page says while its answer is on its way, or why it didn't come.
fn waiting<T>(flow: &mut Flow<'_>, slot: &Slot<T>, what: &str) -> bool {
    if slot.value.is_some() {
        return false;
    }
    let theme = flow.theme;
    match &slot.error {
        Some(error) => {
            flow.line(Line::from(Span::styled(
                format!(" Could not read {what}"),
                theme.strong(),
            )));
            flow.wrapped(error, theme.tone(Tone::Bad), 1);
        }
        None => flow.line(Line::from(Span::styled(
            format!(" Reading {what}…"),
            theme.muted(),
        ))),
    }
    true
}

fn marker(flow: &Flow<'_>, selected: bool) -> Span<'static> {
    if selected {
        Span::styled("▌", flow.theme.accent())
    } else {
        Span::raw(" ")
    }
}

/// Puts the selected row on the raised surface.
fn raise(flow: &mut Flow<'_>, top: u16, selected: bool) {
    if selected && top < flow.buf.area.bottom() {
        let height = (flow.y - top).min(flow.buf.area.bottom() - top);
        let rect = Rect::new(flow.x, top, flow.width, height);
        flow.buf.set_style(rect, flow.theme.raised());
    }
}

pub fn draw_agents(app: &App, flow: &mut Flow<'_>, _now: &Now) {
    let theme = flow.theme;
    let slot = &app.data.agents;
    if waiting(flow, slot, "the agents") {
        return;
    }
    let agents = slot.value.as_deref().unwrap_or_default();
    flow.wrapped(
        "Connecting an agent points its config at slopmax, so its requests go through the pool; \
         disconnecting puts the config back as it was.",
        theme.muted(),
        1,
    );
    flow.gap();
    for (i, agent) in agents.iter().enumerate() {
        let selected = i == app.cursor;
        let top = flow.y;
        let (tone, state) = match (agent.installed, agent.wired) {
            (_, true) => (Tone::Good, "connected"),
            (true, false) => (Tone::Muted, "not connected"),
            (false, false) => (Tone::Muted, "not installed"),
        };
        let title_style = if selected {
            theme.strong().patch(theme.accent())
        } else {
            theme.strong()
        };
        flow.split_line(
            Line::from(vec![
                marker(flow, selected),
                Span::styled(agent.title.clone(), title_style),
            ]),
            Line::from(vec![
                dot(theme, tone),
                Span::styled(format!(" {state}"), theme.tone(tone)),
            ]),
        );
        let mut detail = vec![Span::styled(
            format!("  {}", agent.config_path),
            theme.muted(),
        )];
        if let Some(to) = &agent.wired_to {
            detail.push(Span::styled(format!(" → {to}"), Style::new()));
        }
        if agent.backed_up {
            detail.push(Span::styled(" · backed up", theme.muted()));
        }
        flow.line(Line::from(detail));
        raise(flow, top, selected);
        flow.hit(
            Rect::new(flow.x, top, flow.width, flow.y - top),
            Hit::Row(i),
        );
        flow.gap();
    }
    flow.line(Line::from(vec![
        Span::styled(" slopmax run claude", theme.accent()),
        Span::styled(
            "  runs an agent through slopmax without changing its config",
            theme.muted(),
        ),
    ]));
}

pub fn draw_access(app: &App, flow: &mut Flow<'_>, _now: &Now) {
    let theme = flow.theme;
    flow.section("Add an account", None);
    for (command, what) in [
        ("slopmax login claude", "sign in to a Claude subscription"),
        ("slopmax login codex", "sign in to a ChatGPT subscription"),
        ("slopmax login grok", "sign in to SuperGrok"),
        ("slopmax account import", "copy the logins your agents hold"),
        (
            "slopmax login anthropic --key",
            "add an API key, billed per token",
        ),
    ] {
        flow.line(Line::from(vec![
            Span::styled(format!("  {command:<32}"), theme.accent()),
            Span::styled(what, theme.muted()),
        ]));
    }
    flow.gap();

    flow.section(
        "Client keys",
        Some(Line::from(vec![
            Span::styled("a", theme.strong()),
            Span::styled(" add  ", theme.muted()),
            Span::styled("x", theme.strong()),
            Span::styled(" revoke", theme.muted()),
        ])),
    );
    if !waiting(flow, &app.data.keys, "the keys") {
        let keys = app.data.keys.value.as_deref().unwrap_or_default();
        if keys.is_empty() {
            flow.wrapped(
                "No client keys. A key lets another machine or tool use the proxy, and nothing else.",
                theme.muted(),
                1,
            );
        }
        for (i, key) in keys.iter().enumerate() {
            let selected = i == app.cursor;
            let top = flow.y;
            let models = if key.models.is_empty() {
                "any model".to_owned()
            } else {
                key.models.join(", ")
            };
            flow.line(Line::from(vec![
                marker(flow, selected),
                Span::styled(format!("{:<24}", key.name), theme.strong()),
                Span::styled(models, theme.muted()),
            ]));
            raise(flow, top, selected);
            flow.hit(Rect::new(flow.x, top, flow.width, 1), Hit::Row(i));
        }
    }
    flow.gap();

    flow.section("Other machines", None);
    if waiting(flow, &app.data.tailnet, "the tailnet") {
        return;
    }
    let Some(tailnet) = &app.data.tailnet.value else {
        return;
    };
    let (tone, state) = match tailnet.tailscale {
        TailscaleState::Running => (Tone::Good, "running"),
        TailscaleState::Missing => (Tone::Muted, "not installed"),
        TailscaleState::Down => (Tone::Bad, "not answering"),
        TailscaleState::SignedOut => (Tone::Warn, "signed out"),
        TailscaleState::Off => (Tone::Muted, "off"),
        TailscaleState::NeedsApproval => (Tone::Warn, "waiting for the tailnet's approval"),
        TailscaleState::Unknown => (Tone::Warn, "in a state slopmax doesn't know"),
    };
    let row = |name: &str, value: Vec<Span<'static>>| {
        let mut spans = vec![Span::styled(format!("  {name:<14}"), theme.muted())];
        spans.extend(value);
        Line::from(spans)
    };
    flow.line(row(
        "Tailscale",
        vec![
            dot(theme, tone),
            Span::styled(format!(" {state}"), theme.tone(tone)),
        ],
    ));
    match &tailnet.url {
        Some(url) => {
            let how = match tailnet.transport {
                Some(Transport::Socket) => " · over slopmax's own socket",
                Some(Transport::Private) => " · over a private path",
                Some(Transport::Loopback) => " · keys only",
                None => "",
            };
            flow.line(row(
                "Published at",
                vec![
                    Span::styled(url.clone(), theme.accent()),
                    Span::styled(how, theme.muted()),
                ],
            ));
        }
        None => flow.line(row(
            "Published",
            vec![Span::styled(
                "no · `slopmax tailscale on` shares it",
                theme.muted(),
            )],
        )),
    }
    let names = |list: Vec<String>| {
        if list.is_empty() {
            Span::styled("none", theme.muted())
        } else {
            Span::raw(list.join(", "))
        }
    };
    flow.line(row("Users", vec![names(tailnet.users.clone())]));
    flow.line(row(
        "Admins",
        vec![names(
            tailnet.admins.iter().map(|a| a.machine.clone()).collect(),
        )],
    ));
    if tailnet.funnel {
        flow.line(row(
            "Funnel",
            vec![Span::styled(
                "on: the port is open to the internet, which slopmax refuses",
                theme.tone(Tone::Bad),
            )],
        ));
    }
    if let Some(problem) = &tailnet.problem {
        flow.gap();
        flow.line(Line::from(vec![
            Span::raw("  "),
            dot(theme, Tone::Warn),
            Span::raw(format!(" {}", problem.text)),
        ]));
        if let Some(fix) = &problem.fix {
            flow.line(Line::from(Span::styled(
                format!("    → {fix}"),
                theme.accent(),
            )));
        }
    }
}

fn level_mark(level: Level) -> (&'static str, Tone) {
    match level {
        Level::Ok => ("✓", Tone::Good),
        Level::Info => ("i", Tone::Accent),
        Level::Warn => ("▲", Tone::Warn),
        Level::Fail => ("✕", Tone::Bad),
    }
}

pub fn draw_diagnostics(app: &App, flow: &mut Flow<'_>, _now: &Now) {
    let theme = flow.theme;
    let slot = &app.data.doctor;
    if waiting(flow, slot, "the setup") {
        return;
    }
    let sections = slot.value.as_deref().unwrap_or_default();
    let findings = || sections.iter().flat_map(|s| &s.findings);
    let tally = |level: Level| findings().filter(|f| f.level == level).count();
    let mut summary = vec![Span::raw(" ")];
    for (level, words) in [
        (Level::Ok, "fine"),
        (Level::Info, "to know"),
        (Level::Warn, "to look at"),
        (Level::Fail, "failing"),
    ] {
        let n = tally(level);
        if n == 0 && level != Level::Ok {
            continue;
        }
        let (mark, tone) = level_mark(level);
        summary.push(Span::styled(mark, theme.tone(tone)));
        summary.push(Span::styled(format!(" {n} {words}   "), theme.muted()));
    }
    flow.line(Line::from(summary));
    flow.gap();
    for section in sections {
        let worst = section.findings.iter().map(|f| f.level).max();
        let trailing = worst.filter(|l| *l >= Level::Warn).map(|l| {
            let (mark, tone) = level_mark(l);
            Line::from(Span::styled(mark, theme.tone(tone)))
        });
        flow.section(&section.title, trailing);
        for finding in &section.findings {
            let (mark, tone) = level_mark(finding.level);
            let width = flow.width.saturating_sub(5) as usize;
            for (i, line) in super::widgets::wrap(&finding.text, width)
                .into_iter()
                .enumerate()
            {
                let lead = if i == 0 {
                    Span::styled(format!(" {mark} "), theme.tone(tone))
                } else {
                    Span::raw("   ")
                };
                flow.line(Line::from(vec![lead, Span::raw(line)]));
            }
            if let Some(fix) = &finding.fix {
                for line in super::widgets::wrap(fix, width.saturating_sub(2)) {
                    flow.line(Line::from(vec![
                        Span::styled("   → ", theme.muted()),
                        Span::styled(line, theme.accent()),
                    ]));
                }
            }
        }
        flow.gap();
    }
}

pub fn draw_settings(app: &App, flow: &mut Flow<'_>, _now: &Now) {
    let theme = flow.theme;
    let slot = &app.data.settings;
    if waiting(flow, slot, "the settings") {
        return;
    }
    let Some(view) = &slot.value else {
        return;
    };
    let live = &view.settings.live;
    let mut group = "";
    let value_w = 16usize;
    let title_w = 30usize;
    for (i, setting) in LIVE.iter().enumerate() {
        let this = setting_group(setting.name);
        if this != group {
            if !group.is_empty() {
                flow.gap();
            }
            flow.section(this, None);
            group = this;
        }
        let selected = i == app.cursor;
        let top = flow.y;
        let value = match live.get(setting.name) {
            Some(LiveValue::Switch(true)) => Span::styled("● on", theme.tone(Tone::Good)),
            Some(LiveValue::Switch(false)) => Span::styled("○ off", theme.muted()),
            Some(LiveValue::Minutes(0)) if setting.name == "pollMinutes" => {
                Span::styled("off", theme.muted())
            }
            Some(LiveValue::Minutes(m)) => Span::raw(format!("{m} min")),
            Some(LiveValue::Strategy(s)) => Span::styled(s.as_str(), theme.accent()),
            None => Span::styled("—", theme.muted()),
        };
        let pad = value_w.saturating_sub(value.width());
        let title_style = if selected {
            theme.strong().patch(theme.accent())
        } else {
            Style::new()
        };
        let summary_w = (flow.width as usize).saturating_sub(title_w + value_w + 2);
        flow.line(Line::from(vec![
            marker(flow, selected),
            Span::styled(
                format!("{:<w$}", setting_title(setting.name), w = title_w),
                title_style,
            ),
            value,
            Span::raw(" ".repeat(pad)),
            Span::styled(format::fit(setting.summary, summary_w), theme.muted()),
        ]));
        raise(flow, top, selected);
        flow.hit(Rect::new(flow.x, top, flow.width, 1), Hit::Row(i));
    }
    flow.gap();
    if !view.restart_needed.is_empty() {
        flow.line(Line::from(vec![
            Span::raw(" "),
            dot(theme, Tone::Warn),
            Span::styled(
                format!(
                    " {} changed in config.toml and apply after a restart: `slopmax proxy restart`",
                    format::listed(&view.restart_needed)
                ),
                theme.tone(Tone::Warn),
            ),
        ]));
        flow.gap();
    }
    flow.section(
        "Proxy",
        Some(Line::from(Span::styled(
            "set in config.toml",
            theme.muted(),
        ))),
    );
    let s = &view.settings;
    let row = |name: &str, value: String| {
        Line::from(vec![
            Span::styled(format!("  {name:<w$}", w = title_w - 1), theme.muted()),
            Span::raw(value),
        ])
    };
    flow.line(row("Listens on", s.listen.clone()));
    if let Some(upstream) = &s.upstream_proxy {
        flow.line(row("Upstream proxy", upstream.clone()));
    }
    let notify = match (&s.notify.webhook, &s.notify.command) {
        (Some(hook), _) => format!("webhook {hook}"),
        (None, Some(command)) => format!("command {command}"),
        (None, None) => "off".into(),
    };
    flow.line(row("Notifications", notify));
    if !s.aliases.is_empty() {
        flow.line(row("Model aliases", s.aliases.len().to_string()));
    }
    if !s.fallbacks.is_empty() {
        flow.line(row(
            "Fallbacks",
            format::count(s.fallbacks.len() as u64, "model"),
        ));
    }
    flow.line(row(
        "Client keys",
        format::count(s.keys.len() as u64, "key"),
    ));
}
