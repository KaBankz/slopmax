//! Every page drawn from the contract's fixtures (the daemon's real
//! answers) at a roomy 120×36 and a classic 80×24, held as snapshots.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use slopmax_client::api::AgentId;
use slopmax_client::api::ledger::HistoryRange;
use slopmax_client::api::report::{AgentWiring, Finding, Level, Section};
use slopmax_common::time::SignedDuration;

use super::draw;
use crate::app::{App, Modal, Page};
use crate::data::{Action, Link, range_index};
use crate::format::Now;
use crate::theme::Theme;

/// A fixture's body, as the daemon answered.
pub fn fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = format!(
        "{}/../../contract/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    serde_json::from_value(value["body"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Two and a half hours before the fixtures' resets.
pub fn now() -> Now {
    Now {
        at: "2026-11-01T09:30:00Z".parse().unwrap(),
        offset: SignedDuration::ZERO,
    }
}

/// The screen with every answer in, as from a daemon of the fixtures.
pub fn app(page: Page) -> App {
    let mut app = App::new(None);
    let data = &mut app.data;
    data.link = Link::Live("0.14.0".into());
    data.report = Some(fixture("system.status.ok"));
    let at = std::time::Instant::now();
    for range in [HistoryRange::Today, HistoryRange::Week, HistoryRange::Month] {
        let mut history: slopmax_client::api::ledger::History = fixture("usage.history.ok");
        history.range = range;
        data.history[range_index(range)].finish(Ok(history), at);
    }
    data.pools
        .entry(slopmax_client::api::Provider::Claude)
        .or_default()
        .finish(Ok(fixture("usage.pool.ok")), at);
    data.requests.finish(Ok(fixture("usage.requests.ok")), at);
    data.machines
        .finish(Ok(fixture("usage.summary.machine.ok")), at);
    data.settings.finish(Ok(fixture("config.settings.ok")), at);
    data.keys.finish(Ok(fixture("config.keys.ok")), at);
    data.tailnet.finish(Ok(fixture("tailnet.view.ok")), at);
    data.agents.finish(Ok(agents()), at);
    data.doctor.finish(Ok(doctor()), at);
    app.page = page;
    app.entered = false;
    app.frozen = Some(now().at);
    app
}

fn agents() -> Vec<AgentWiring> {
    vec![
        AgentWiring {
            id: AgentId::ClaudeCode,
            title: "Claude Code".into(),
            installed: true,
            config_path: "~/.claude/settings.json".into(),
            wired_to: Some("http://127.0.0.1:7567".into()),
            wired: true,
            backed_up: true,
        },
        AgentWiring {
            id: AgentId::Codex,
            title: "Codex".into(),
            installed: true,
            config_path: "~/.codex/config.toml".into(),
            wired_to: None,
            wired: false,
            backed_up: false,
        },
        AgentWiring {
            id: AgentId::GrokBuild,
            title: "Grok Build".into(),
            installed: false,
            config_path: "~/.grok/settings.json".into(),
            wired_to: None,
            wired: false,
            backed_up: false,
        },
    ]
}

fn doctor() -> Vec<Section> {
    let finding = |level, text: &str, fix: Option<&str>| Finding {
        level,
        text: text.into(),
        fix: fix.map(Into::into),
    };
    vec![
        Section {
            title: "Proxy".into(),
            findings: vec![
                finding(Level::Ok, "slopmax 0.14.0 serves on 127.0.0.1:7567", None),
                finding(Level::Ok, "it starts at login (systemd)", None),
            ],
        },
        Section {
            title: "Accounts".into(),
            findings: vec![
                finding(Level::Ok, "Spare: signed in, token fresh", None),
                finding(
                    Level::Warn,
                    "codex@example.com is limited until 12:00 and holds a limit reset that expires first",
                    Some("slopmax account redeem codex@example.com"),
                ),
            ],
        },
        Section {
            title: "Agents".into(),
            findings: vec![
                finding(
                    Level::Info,
                    "Codex isn't connected; it talks to OpenAI directly",
                    Some("slopmax agent connect codex"),
                ),
                finding(Level::Fail, "Grok Build isn't installed", None),
            ],
        },
    ]
}

/// The screen as text, a line per row.
pub fn render(app: &mut App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    let now = now();
    terminal
        .draw(|frame| draw(frame, app, &Theme::plain(), &now, None))
        .unwrap();
    terminal.backend().to_string()
}

fn pages() -> Vec<(&'static str, Page)> {
    use slopmax_client::api::Provider;
    vec![
        ("overview", Page::Overview),
        ("claude", Page::Provider(Provider::Claude)),
        ("chatgpt", Page::Provider(Provider::Codex)),
        ("anthropic", Page::Provider(Provider::Anthropic)),
        ("usage", Page::Usage),
        ("performance", Page::Performance),
        ("requests", Page::Requests),
        ("agents", Page::Agents),
        ("access", Page::Access),
        ("diagnostics", Page::Diagnostics),
        ("settings", Page::Settings),
    ]
}

#[test]
fn every_page_at_120_by_36() {
    for (name, page) in pages() {
        let mut app = app(page);
        insta::assert_snapshot!(format!("{name}_120x36"), render(&mut app, 120, 36));
    }
}

#[test]
fn every_page_at_80_by_24() {
    for (name, page) in pages() {
        let mut app = app(page);
        insta::assert_snapshot!(format!("{name}_80x24"), render(&mut app, 80, 24));
    }
}

#[test]
fn help_and_dialogs_sit_over_the_page() {
    let mut app = app(Page::Overview);
    app.help = true;
    insta::assert_snapshot!("help_80x24", render(&mut app, 80, 24));
    let mut app = self::app(Page::Provider(slopmax_client::api::Provider::Codex));
    app.modal = Some(Modal::Confirm {
        title: "Redeem a limit reset on codex@example.com?".into(),
        body: "It resets the account's usage windows at once and spends one of the 1 it holds."
            .into(),
        yes: "Redeem".into(),
        action: Action::Redeem("codex-fbfb76d8".into()),
    });
    insta::assert_snapshot!("confirm_80x24", render(&mut app, 80, 24));
    let mut app = self::app(Page::Settings);
    app.modal = Some(Modal::Strategy { selected: 1 });
    insta::assert_snapshot!("strategy_120x36", render(&mut app, 120, 36));
}

#[test]
fn a_cramped_terminal_says_so() {
    let mut app = app(Page::Overview);
    let screen = render(&mut app, 40, 10);
    assert!(screen.contains("Make the terminal larger"), "{screen}");
}

#[test]
fn before_the_daemon_answers_the_overview_says_it_is_looking() {
    let mut app = App::new(None);
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Looking for slopmax"), "{screen}");
    assert!(screen.contains("connecting"), "{screen}");
}

#[test]
fn the_selected_row_scrolls_into_view() {
    let mut app = app(Page::Settings);
    app.cursor = 9;
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Codex WebSockets"), "{screen}");
}

#[test]
fn clicks_land_on_what_was_drawn() {
    let mut app = app(Page::Overview);
    render(&mut app, 120, 36);
    let usage = app
        .hits
        .iter()
        .find(|(_, hit)| *hit == crate::app::Hit::Page(5))
        .map(|(rect, _)| *rect)
        .expect("the sidebar's sixth row");
    let click = crossterm::event::MouseEvent {
        kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
        column: usage.x + 3,
        row: usage.y,
        modifiers: crossterm::event::KeyModifiers::NONE,
    };
    app.mouse(click);
    assert_eq!(app.page, Page::Usage);
}
