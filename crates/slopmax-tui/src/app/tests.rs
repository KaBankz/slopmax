use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use slopmax_client::api::Provider;
use slopmax_client::api::events::Event;
use slopmax_client::api::ledger::{HistoryRange, LedgerRecord, RequestOutcome};
use slopmax_client::api::settings::LivePatch;

use super::*;
use crate::data::{Action, Link, Msg, What};
use crate::ui::tests::{app, fixture};

fn press(app: &mut App, code: KeyCode) -> Vec<Cmd> {
    app.key(KeyEvent::from(code))
}

fn typed(app: &mut App, text: &str) {
    for c in text.chars() {
        press(app, KeyCode::Char(c));
    }
}

#[test]
fn the_sidebar_lists_the_providers_with_accounts_between_overview_and_usage() {
    let app = app(Page::Overview);
    let titles: Vec<&str> = app.pages().iter().map(|p| p.title()).collect();
    assert_eq!(
        titles,
        [
            "Overview",
            "Claude",
            "ChatGPT",
            "Anthropic API",
            "Compatible API",
            "Usage",
            "Performance",
            "Requests",
            "Agents",
            "Access",
            "Diagnostics",
            "Settings"
        ]
    );
}

#[test]
fn tab_number_keys_and_arrows_move_between_pages_fetching_what_each_shows() {
    let mut app = app(Page::Overview);
    let cmds = press(&mut app, KeyCode::Tab);
    assert_eq!(app.page, Page::Provider(Provider::Claude));
    assert_eq!(cmds, [Cmd::Fetch(What::Pool(Provider::Claude))]);
    press(&mut app, KeyCode::BackTab);
    assert_eq!(app.page, Page::Overview);
    // Wraps around from the first page to the last.
    press(&mut app, KeyCode::Left);
    assert_eq!(app.page, Page::Settings);
    let cmds = press(&mut app, KeyCode::Char('6'));
    assert_eq!(app.page, Page::Usage);
    assert_eq!(
        cmds,
        [
            Cmd::Fetch(What::History(HistoryRange::Week)),
            Cmd::Fetch(What::Machines(HistoryRange::Week))
        ]
    );
    // A page already being fetched isn't asked for twice.
    assert_eq!(press(&mut app, KeyCode::Char('6')), []);
}

#[test]
fn the_cursor_stays_on_the_page_s_rows() {
    let mut app = app(Page::Provider(Provider::Claude));
    assert_eq!(app.rows(), 2);
    press(&mut app, KeyCode::Down);
    press(&mut app, KeyCode::Down);
    press(&mut app, KeyCode::Char('j'));
    assert_eq!(app.cursor, 1);
    press(&mut app, KeyCode::Char('g'));
    assert_eq!(app.cursor, 0);
    press(&mut app, KeyCode::End);
    assert_eq!(app.cursor, 1);
    // A page without rows scrolls instead.
    let mut usage = self::app(Page::Usage);
    press(&mut usage, KeyCode::Down);
    assert_eq!((usage.cursor, usage.scroll), (0, 1));
}

#[test]
fn turning_an_account_off_asks_first_and_turning_it_on_does_not() {
    let mut app = app(Page::Provider(Provider::Claude));
    assert_eq!(press(&mut app, KeyCode::Char(' ')), []);
    let Some(Modal::Confirm { action, .. }) = &app.modal else {
        panic!("asks first: {:?}", app.modal);
    };
    assert_eq!(*action, Action::Disable("claude-7cad1d23".into()));
    // Any other key leaves the dialog up; `n` closes it.
    press(&mut app, KeyCode::Char('x'));
    assert!(app.modal.is_some());
    press(&mut app, KeyCode::Char('n'));
    assert!(app.modal.is_none());
    press(&mut app, KeyCode::Char(' '));
    assert_eq!(
        press(&mut app, KeyCode::Char('y')),
        [Cmd::Act(Action::Disable("claude-7cad1d23".into()))]
    );
    if let Some(report) = &mut app.data.report {
        report.accounts[0].disabled = true;
    }
    assert_eq!(
        press(&mut app, KeyCode::Char(' ')),
        [Cmd::Act(Action::Enable("claude-7cad1d23".into()))]
    );
}

#[test]
fn account_keys_prefer_check_and_redeem() {
    let mut app = app(Page::Provider(Provider::Claude));
    assert_eq!(
        press(&mut app, KeyCode::Char('p')),
        [Cmd::Act(Action::Pin("claude-7cad1d23".into()))]
    );
    assert_eq!(
        press(&mut app, KeyCode::Char('c')),
        [Cmd::Act(Action::Check("claude-7cad1d23".into()))]
    );
    // Nothing is pinned, so there is nothing to let go of.
    assert_eq!(press(&mut app, KeyCode::Char('a')), []);
    // Spare holds no limit reset: a toast says so, and nothing is asked.
    assert_eq!(press(&mut app, KeyCode::Char('R')), []);
    assert!(app.modal.is_none());
    assert_eq!(app.toasts.len(), 1);

    let mut codex = self::app(Page::Provider(Provider::Codex));
    press(&mut codex, KeyCode::Char('R'));
    let Some(Modal::Confirm { action, .. }) = &codex.modal else {
        panic!("asks first: {:?}", codex.modal);
    };
    assert_eq!(*action, Action::Redeem("codex-fbfb76d8".into()));
}

#[test]
fn the_feed_filters_as_you_type_and_esc_clears_it() {
    let mut app = app(Page::Requests);
    let all = app.feed().len();
    assert!(all >= 2);
    press(&mut app, KeyCode::Char('/'));
    assert!(app.filtering);
    typed(&mut app, "gpt-6");
    assert_eq!(app.feed().len(), 1);
    // Typing doesn't reach the page's keys.
    assert_eq!(app.page, Page::Requests);
    press(&mut app, KeyCode::Enter);
    assert!(!app.filtering);
    assert_eq!(app.filter, "gpt-6");
    press(&mut app, KeyCode::Esc);
    assert_eq!(app.feed().len(), all);
    assert!(!app.quit);
    press(&mut app, KeyCode::Esc);
    assert!(app.quit);
}

#[test]
fn the_feed_s_range_and_outcome_ask_the_daemon_again() {
    let mut app = app(Page::Requests);
    let cmds = press(&mut app, KeyCode::Char('o'));
    assert_eq!(app.data.query.outcome, RequestOutcome::Answered);
    assert!(
        matches!(&cmds[..], [Cmd::Fetch(What::Requests(q))] if q.outcome == RequestOutcome::Answered)
    );
    // An answer to the query before is dropped.
    let old = slopmax_client::RequestQuery::default();
    app.apply(Msg::Fetched(Box::new(crate::data::Fetched::Requests(
        old,
        Err("late".into()),
    ))));
    assert!(app.data.requests.error.is_none());
    let cmds = press(&mut app, KeyCode::Char('r'));
    assert_eq!(app.data.query.range, HistoryRange::Week);
    assert_eq!(cmds.len(), 1);
}

#[test]
fn a_request_from_the_stream_tops_the_feed_and_makes_the_ledger_stale() {
    let mut app = app(Page::Requests);
    let before = app.feed().len();
    let page: slopmax_client::api::ledger::RequestPage = fixture("usage.requests.ok");
    let LedgerRecord::Request(mut record) = page.rows[0].record.clone();
    record.model = Some("claude-sonnet-5-5".into());
    app.apply(Msg::Event(Box::new(Event::Request {
        record: LedgerRecord::Request(record),
    })));
    assert_eq!(app.feed().len(), before + 1);
    assert_eq!(app.arrived, 1);
    let LedgerRecord::Request(top) = &app.feed()[0].record;
    assert_eq!(top.model.as_deref(), Some("claude-sonnet-5-5"));
    assert!(app.data.requests.stale && app.data.history(HistoryRange::Week).stale);
    // Fetched again once it settles, not at once.
    assert_eq!(app.tick(std::time::Instant::now()), []);
    let later = std::time::Instant::now() + std::time::Duration::from_secs(4);
    assert!(matches!(
        &app.tick(later)[..],
        [Cmd::Fetch(What::Requests(_))]
    ));
}

#[test]
fn settings_switch_at_once_and_ask_for_minutes_and_strategy() {
    let mut app = app(Page::Settings);
    // Strategy.
    press(&mut app, KeyCode::Enter);
    assert_eq!(app.modal, Some(Modal::Strategy { selected: 0 }));
    press(&mut app, KeyCode::Down);
    let cmds = press(&mut app, KeyCode::Enter);
    assert_eq!(
        cmds,
        [Cmd::Act(Action::Settings(LivePatch {
            strategy: Some(slopmax_client::api::Strategy::FillFirst),
            ..Default::default()
        }))]
    );
    // Session affinity is on in the fixture: off it goes.
    press(&mut app, KeyCode::Down);
    let cmds = press(&mut app, KeyCode::Char(' '));
    assert_eq!(
        cmds,
        [Cmd::Act(Action::Settings(LivePatch {
            session_affinity: Some(false),
            ..Default::default()
        }))]
    );
    // Session memory takes a number of minutes, and refuses anything else.
    press(&mut app, KeyCode::Down);
    press(&mut app, KeyCode::Enter);
    assert!(matches!(app.modal, Some(Modal::Input { .. })));
    press(&mut app, KeyCode::Backspace);
    press(&mut app, KeyCode::Backspace);
    typed(&mut app, "0");
    assert_eq!(press(&mut app, KeyCode::Enter), []);
    assert!(app.modal.is_some(), "kept open to fix");
    press(&mut app, KeyCode::Backspace);
    app.paste("45\n");
    assert_eq!(
        press(&mut app, KeyCode::Enter),
        [Cmd::Act(Action::Settings(LivePatch {
            session_minutes: Some(45),
            ..Default::default()
        }))]
    );
}

#[test]
fn keys_are_made_by_name_and_revoked_after_asking() {
    let mut app = app(Page::Access);
    press(&mut app, KeyCode::Char('a'));
    // An empty name is not sent.
    assert_eq!(press(&mut app, KeyCode::Enter), []);
    typed(&mut app, "ci");
    assert_eq!(
        press(&mut app, KeyCode::Enter),
        [Cmd::Act(Action::MakeKey("ci".into()))]
    );
    press(&mut app, KeyCode::Char('x'));
    assert_eq!(
        press(&mut app, KeyCode::Enter),
        [Cmd::Act(Action::RemoveKey("laptop".into()))]
    );
}

#[test]
fn agents_connect_at_once_and_disconnect_after_asking() {
    let mut app = app(Page::Agents);
    // Claude Code is connected: `c` does nothing, `x` asks.
    assert_eq!(press(&mut app, KeyCode::Char('c')), []);
    press(&mut app, KeyCode::Char('x'));
    assert_eq!(
        press(&mut app, KeyCode::Char('y')),
        [Cmd::Act(Action::Disconnect(
            slopmax_client::api::AgentId::ClaudeCode
        ))]
    );
    press(&mut app, KeyCode::Down);
    assert_eq!(
        press(&mut app, KeyCode::Enter),
        [Cmd::Act(Action::Connect(
            slopmax_client::api::AgentId::Codex
        ))]
    );
}

#[test]
fn refusals_and_results_come_back_as_toasts() {
    let mut app = app(Page::Provider(Provider::Claude));
    app.apply(Msg::Done(
        Action::Pin("claude-7cad1d23".into()),
        Err("This machine may use the hub but not change it".into()),
    ));
    assert_eq!(app.toasts.last().map(|t| t.tone), Some(Tone::Bad));
    let report = fixture("accounts.pin.ok");
    app.apply(Msg::Done(
        Action::Pin("claude-7cad1d23".into()),
        Ok(crate::data::Outcome::Report(
            Box::new(report),
            "New sessions go to Spare first".into(),
        )),
    ));
    assert_eq!(app.toasts.last().map(|t| t.tone), Some(Tone::Good));
    assert!(app.accounts().iter().any(|a| a.pinned));
}

#[test]
fn losing_the_stream_says_so_once() {
    let mut app = app(Page::Overview);
    app.apply(Msg::Link(Link::Lost("refused".into())));
    app.apply(Msg::Link(Link::Lost("refused".into())));
    assert_eq!(app.toasts.len(), 1);
}

#[test]
fn ctrl_c_quits_from_anywhere_and_q_closes_help_first() {
    let mut app = app(Page::Overview);
    press(&mut app, KeyCode::Char('?'));
    assert!(app.help);
    press(&mut app, KeyCode::Char('q'));
    assert!(!app.help && !app.quit);
    app.modal = Some(Modal::Strategy { selected: 0 });
    app.key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.quit);
}

#[test]
fn the_overview_opens_the_selected_pool() {
    let mut app = app(Page::Overview);
    press(&mut app, KeyCode::Down);
    press(&mut app, KeyCode::Enter);
    assert_eq!(app.page, Page::Provider(Provider::Codex));
}
