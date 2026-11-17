//! Every page drawn from the contract's fixtures (the daemon's real
//! answers) at a roomy 120×36 and a classic 80×24, held as snapshots.

use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use slopmax_client::api::ledger::{History, HistoryRange, RequestPage};
use slopmax_client::api::report::{AgentWiring, Finding, Level, Report, Section};
use slopmax_client::api::{AgentId, Provider, Tone};
use slopmax_common::time::SignedDuration;

use super::draw;
use crate::app::{App, Hit, Input, Modal, Page};
use crate::data::{LATEST, Link, range_index};
use crate::format::Now;
use crate::fx::Effects;
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
        let mut history: History = fixture("usage.history.ok");
        history.range = range;
        data.history[range_index(range)].finish(Ok(history), at);
        data.machines[range_index(range)].finish(Ok(fixture("usage.summary.machine.ok")), at);
    }
    data.pools
        .entry(Provider::Claude)
        .or_default()
        .finish(Ok(fixture("usage.pool.ok")), at);
    data.requests.finish(Ok(fixture("usage.requests.ok")), at);
    let mut latest: RequestPage = fixture("usage.requests.ok");
    latest.rows.truncate(LATEST as usize);
    data.latest.finish(Ok(latest), at);
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

/// The screen as text, drawn with effects as the terminal draws it.
fn render_fx(app: &mut App, fx: &mut Effects, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    let now = now();
    terminal
        .draw(|frame| draw(frame, app, &Theme::plain(), &now, Some(fx)))
        .unwrap();
    terminal.backend().to_string()
}

fn pages() -> Vec<(&'static str, Page)> {
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

/// Checks every snapshot before failing, so one run shows every change.
fn snapshots(shots: Vec<(String, String)>) {
    let failed: Vec<String> = shots
        .into_iter()
        .filter_map(|(name, screen)| {
            let checked =
                std::panic::catch_unwind(|| insta::assert_snapshot!(name.clone(), screen));
            checked.is_err().then_some(name)
        })
        .collect();
    assert!(failed.is_empty(), "snapshots that changed: {failed:?}");
}

#[test]
fn every_page_at_120_by_36() {
    let shots = pages()
        .into_iter()
        .map(|(name, page)| (format!("{name}_120x36"), render(&mut app(page), 120, 36)))
        .collect();
    snapshots(shots);
}

#[test]
fn every_page_at_80_by_24() {
    let shots = pages()
        .into_iter()
        .map(|(name, page)| (format!("{name}_80x24"), render(&mut app(page), 80, 24)))
        .collect();
    snapshots(shots);
}

fn press(app: &mut App, code: KeyCode) {
    app.key(KeyEvent::from(code));
}

#[test]
fn help_and_dialogs_sit_over_the_page() {
    let mut shots = Vec::new();
    let mut app = app(Page::Overview);
    press(&mut app, KeyCode::Char('?'));
    // Help lists ctrl-z only where a shell can resume slopmax.
    if cfg!(unix) {
        shots.push(("help_80x24".into(), render(&mut app, 80, 24)));
    }
    // The redeem dialog as `R` brings it up.
    let mut app = self::app(Page::Provider(Provider::Codex));
    press(&mut app, KeyCode::Char('R'));
    assert!(matches!(app.modal, Some(Modal::Confirm { .. })));
    shots.push(("confirm_80x24".into(), render(&mut app, 80, 24)));
    let mut app = self::app(Page::Settings);
    press(&mut app, KeyCode::Enter);
    press(&mut app, KeyCode::Down);
    shots.push(("strategy_120x36".into(), render(&mut app, 120, 36)));
    // Too short for each strategy's summary: they go one a line, inside
    // the border.
    shots.push(("strategy_80x13".into(), render(&mut app, 80, 13)));
    // A new key: shown whole, however long.
    let mut app = self::app(Page::Access);
    app.modal = Some(Modal::Secret {
        title: "The key \"ci\"".into(),
        text: format!("sk-slopmax-{}", "0123456789abcdef".repeat(6)),
        note: "Shown this once. Clients present it as a bearer token or x-api-key.".into(),
    });
    shots.push(("secret_80x24".into(), render(&mut app, 80, 24)));
    // A long name keeps its end, where the cursor is, in view.
    let mut app = self::app(Page::Access);
    press(&mut app, KeyCode::Char('a'));
    for c in "a-key-name-long-enough-to-run-past-the-edge-of-the-dialog-box".chars() {
        press(&mut app, KeyCode::Char(c));
    }
    shots.push(("input_80x24".into(), render(&mut app, 80, 24)));
    snapshots(shots);
}

#[test]
fn a_long_confirmation_stays_inside_its_dialog() {
    let mut app = app(Page::Overview);
    app.modal = Some(Modal::Confirm {
        title: "Turn it off?".into(),
        body: "word ".repeat(400),
        yes: "Turn off".into(),
        action: crate::data::Action::Refresh,
    });
    // Drawing past the screen would panic; the keys stay on the last line.
    let screen = render(&mut app, 60, 14);
    assert!(screen.contains("y Turn off"), "{screen}");
}

#[test]
fn a_long_value_keeps_the_cursor_in_view() {
    let mut app = app(Page::Access);
    app.modal = Some(Modal::Input {
        title: "New client key".into(),
        hint: "A name".into(),
        value: "x".repeat(200) + "END",
        input: Input::KeyName,
    });
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("END▏"), "{screen}");
}

#[test]
fn stat_cards_keep_their_words_inside_at_80_and_120() {
    for (page, width, height) in [(Page::Usage, 80, 24), (Page::Usage, 120, 36)] {
        let mut app = app(page);
        let screen = render(&mut app, width, height);
        // Each card's right border follows its text.
        assert!(screen.contains("1 conversation"), "{screen}");
        assert!(!screen.contains("in 1 conversation"), "{screen}");
    }
    let mut app = app(Page::Performance);
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Saved by failover"), "{screen}");
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
    render(&mut app, 80, 24);
    for _ in 0..9 {
        press(&mut app, KeyCode::Down);
    }
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Codex WebSockets"), "{screen}");
}

#[test]
fn what_lies_below_the_last_row_can_be_scrolled_to() {
    // Settings' proxy details sit under its last setting.
    let mut app = app(Page::Settings);
    render(&mut app, 80, 24);
    press(&mut app, KeyCode::End);
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Listens on"), "{screen}");
    assert_eq!(app.cursor, app.rows() - 1);
    // Back up a row keeps the view where it is until the row leaves it.
    let scroll = app.scroll;
    assert!(scroll > 0);
    // The overview's latest requests are under its last row.
    let mut app = self::app(Page::Overview);
    render(&mut app, 80, 24);
    press(&mut app, KeyCode::Char('G'));
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Latest requests"), "{screen}");
    // Down past the last row scrolls on, and the wheel scrolls without
    // moving the selection.
    let mut app = self::app(Page::Access);
    render(&mut app, 80, 24);
    let rows = app.rows();
    for _ in 0..rows + 30 {
        press(&mut app, KeyCode::Down);
    }
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("Tailscale"), "{screen}");
    let mut app = self::app(Page::Overview);
    render(&mut app, 80, 24);
    let wheel = MouseEvent {
        kind: MouseEventKind::ScrollDown,
        column: 40,
        row: 10,
        modifiers: crossterm::event::KeyModifiers::NONE,
    };
    app.mouse(wheel);
    render(&mut app, 80, 24);
    assert_eq!((app.cursor, app.scroll), (0, 3));
}

#[test]
fn a_page_taller_than_the_first_canvas_is_drawn_whole() {
    let mut app = app(Page::Requests);
    if let Some(page) = &mut app.data.requests.value {
        let row = page.rows[0].clone();
        page.rows = vec![row; 600];
        page.matched = 600;
    }
    render(&mut app, 80, 24);
    press(&mut app, KeyCode::End);
    let screen = render(&mut app, 80, 24);
    assert_eq!(app.cursor, 599);
    assert!(screen.contains('▌'), "the last row is drawn: {screen}");
}

#[test]
fn clicks_land_on_what_was_drawn() {
    let mut app = app(Page::Overview);
    render(&mut app, 120, 36);
    let usage = app
        .hits
        .iter()
        .find(|(_, hit)| *hit == Hit::Page(5))
        .map(|(rect, _)| *rect)
        .expect("the sidebar's sixth row");
    let click = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: usage.x + 3,
        row: usage.y,
        modifiers: crossterm::event::KeyModifiers::NONE,
    };
    // With help up, a click closes it and nothing underneath.
    app.help = true;
    app.mouse(click);
    assert!(!app.help);
    assert_eq!(app.page, Page::Overview);
    app.mouse(click);
    assert_eq!(app.page, Page::Usage);
}

/// The footer: the screen's last line.
fn footer(screen: &str) -> &str {
    screen.lines().last().unwrap_or_default()
}

#[test]
fn hints_show_only_keys_that_work_on_the_selection() {
    let mut app = app(Page::Overview);
    // The first item that wants a look is only to look at.
    let screen = render(&mut app, 120, 36);
    assert!(!footer(&screen).contains("redeem"), "{screen}");
    press(&mut app, KeyCode::Down);
    let screen = render(&mut app, 120, 36);
    assert!(footer(&screen).contains("R redeem"), "{screen}");
    // Spare holds no limit reset; claude@example.com doesn't either.
    let mut app = self::app(Page::Provider(Provider::Claude));
    let screen = render(&mut app, 120, 36);
    assert!(!footer(&screen).contains("redeem"), "{screen}");
    // Hints that don't fit are left out whole.
    let mut app = self::app(Page::Provider(Provider::Codex));
    let screen = render(&mut app, 80, 24);
    let last = footer(&screen).trim_matches('"').trim_end();
    assert!(last.ends_with("q quit"), "{last:?}");
}

#[test]
fn a_limit_that_has_passed_is_not_read_as_limited() {
    let report = app(Page::Overview).data.report.unwrap();
    let before = now();
    let after = Now {
        at: "2026-11-01T13:00:00Z".parse().unwrap(),
        ..before
    };
    // codex@example.com is limited until 12:00.
    let (headline, detail, _) = super::overview::standing(&report, &before);
    assert_eq!(headline, "4 of 5 accounts are ready");
    assert!(detail.is_some_and(|d| d.contains("1 limited")));
    let (headline, detail, _) = super::overview::standing(&report, &after);
    assert_eq!(headline, "All 5 accounts are ready");
    assert!(detail.is_none());
    let mut report = report;
    for pool in &mut report.pools {
        pool.next = None;
    }
    let (text, _) = super::provider::next_line(&report, Provider::Codex, &before);
    assert!(text.contains("until 12:00"), "{text}");
    let (text, _) = super::provider::next_line(&report, Provider::Codex, &after);
    assert!(!text.contains("until"), "{text}");
}

#[test]
fn a_dialog_closed_as_it_comes_in_leaves_nothing_moving() {
    let mut app = app(Page::Overview);
    let mut fx = Effects::default();
    press(&mut app, KeyCode::Char('?'));
    render_fx(&mut app, &mut fx, 80, 24);
    assert!(fx.running(), "help resolves out of the page");
    // Closed before it was all in: no frames keep coming for it.
    press(&mut app, KeyCode::Esc);
    render_fx(&mut app, &mut fx, 80, 24);
    assert!(!fx.running());
    // Nor when the terminal is made too small to draw it.
    press(&mut app, KeyCode::Char('?'));
    render_fx(&mut app, &mut fx, 80, 24);
    assert!(fx.running());
    render_fx(&mut app, &mut fx, 40, 10);
    assert!(!fx.running());
    // With room again, it comes in anew.
    render_fx(&mut app, &mut fx, 80, 24);
    assert!(fx.running());
}

#[test]
fn a_request_too_long_for_the_screen_scrolls_and_says_how_to_close_it() {
    let mut app = app(Page::Requests);
    press(&mut app, KeyCode::Enter);
    let screen = render(&mut app, 80, 24);
    assert!(screen.contains("esc close"), "{screen}");
    assert!(!screen.contains("scroll   esc"), "{screen}");
    let screen = render(&mut app, 80, 13);
    assert!(screen.contains("↑↓ scroll   esc close"), "{screen}");
    // Scrolled past its end, it stops at its last field.
    press(&mut app, KeyCode::End);
    render(&mut app, 80, 13);
    let Some(Modal::Request { scroll, .. }) = &app.modal else {
        panic!("still open: {:?}", app.modal);
    };
    assert!(*scroll > 0 && *scroll < 20, "{scroll}");
    let screen = render(&mut app, 80, 13);
    assert!(screen.contains("Session"), "{screen}");
}

/// The screen with a report of no accounts, and nothing fetched.
fn empty(page: Page) -> App {
    let mut app = App::new(None);
    app.data.link = Link::Live("0.14.0".into());
    let mut report: Report = fixture("system.status.ok");
    report.accounts.clear();
    report.pools.clear();
    report.nudges.clear();
    report.update = None;
    app.data.report = Some(report);
    app.page = page;
    app.frozen = Some(now().at);
    app
}

/// The screen before the daemon has said anything.
fn bare(page: Page) -> App {
    let mut app = App::new(None);
    app.page = page;
    app.frozen = Some(now().at);
    app
}

/// Something put over a page, by name.
type Overlay = (&'static str, fn(&mut App));

fn overlay(name: &'static str, put: fn(&mut App)) -> Overlay {
    (name, put)
}

/// What can be over a page: nothing, help, each dialog, toasts too long
/// for their box, a view scrolled as far as it goes, and a filter.
fn overlays() -> Vec<Overlay> {
    vec![
        overlay("nothing", |_| {}),
        overlay("help", |app| app.help = true),
        overlay("confirm", |app| {
            app.modal = Some(Modal::Confirm {
                title: "Redeem a limit reset on someone@a-rather-long-domain.example?".into(),
                body: "word ".repeat(60),
                yes: "Redeem".into(),
                action: crate::data::Action::Refresh,
            });
        }),
        overlay("input", |app| {
            app.modal = Some(Modal::Input {
                title: "Session memory".into(),
                hint: "How long a session keeps going to the account it started on, \
                       in minutes; a session quiet for longer starts over"
                    .into(),
                value: "x".repeat(90),
                input: Input::Minutes("sessionMinutes"),
            });
        }),
        overlay("strategy", |app| {
            app.modal = Some(Modal::Strategy { selected: 2 });
        }),
        overlay("secret", |app| {
            app.modal = Some(Modal::Secret {
                title: "The key \"ci\"".into(),
                text: format!("sk-slopmax-{}", "0123456789abcdef".repeat(6)),
                note: "Shown this once. Clients present it as a bearer token or x-api-key.".into(),
            });
        }),
        overlay("request", |app| {
            let page: RequestPage = fixture("usage.requests.ok");
            app.modal = Some(Modal::Request {
                row: Box::new(page.rows[0].clone()),
                scroll: 0,
            });
        }),
        overlay("request scrolled", |app| {
            let page: RequestPage = fixture("usage.requests.ok");
            app.modal = Some(Modal::Request {
                row: Box::new(page.rows[1].clone()),
                scroll: u16::MAX,
            });
        }),
        overlay("toasts", |app| {
            app.toast("x".repeat(300), Tone::Bad);
            app.toast(format!("Wrote {}", "/a/b".repeat(40)), Tone::Good);
        }),
        overlay("bottom", |app| {
            app.key(KeyEvent::from(KeyCode::End));
            app.key(KeyEvent::from(KeyCode::Up));
        }),
        overlay("filtering", |app| {
            app.filtering = true;
            app.filter = "nothing matches this".into();
        }),
    ]
}

/// A screen made for a page, by what it holds.
type Maker = (&'static str, fn(Page) -> App);

#[test]
fn nothing_panics_at_the_smallest_sizes_with_or_without_data() {
    let makers: [Maker; 3] = [("full", app), ("empty", empty), ("bare", bare)];
    for (data, make) in makers {
        for (name, page) in pages() {
            for (overlay, put) in overlays() {
                for (width, height) in [(48, 12), (49, 13), (60, 16)] {
                    let what = format!("{name} {data} {overlay} {width}x{height}");
                    let drawn = std::panic::catch_unwind(|| {
                        let mut app = make(page);
                        put(&mut app);
                        render(&mut app, width, height);
                        // Again with effects, the page coming in.
                        let mut app = make(page);
                        app.entered = true;
                        put(&mut app);
                        let mut fx = Effects::default();
                        render_fx(&mut app, &mut fx, width, height);
                        render_fx(&mut app, &mut fx, width, height);
                    });
                    assert!(drawn.is_ok(), "panicked drawing {what}");
                }
            }
        }
    }
}
