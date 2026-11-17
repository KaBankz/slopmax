use std::time::{Duration, Instant as Clock};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use slopmax_client::RequestQuery;
use slopmax_client::api::events::Event;
use slopmax_client::api::ledger::{
    HistoryRange, LedgerRecord, RequestOutcome, RequestPage, RequestRecord, Summary,
};
use slopmax_client::api::settings::{LivePatch, NewKey};
use slopmax_client::api::{AgentId, Provider};

use super::*;
use crate::data::{Action, Fetched, Link, Msg, Outcome, What};
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
    // With nothing left to clear, Esc goes back to the overview.
    press(&mut app, KeyCode::Esc);
    assert_eq!(app.page, Page::Overview);
    assert!(!app.quit);
}

#[test]
fn the_filter_matches_the_agent_too() {
    let mut app = app(Page::Requests);
    // Both of the fixture's requests came from Claude Code; one now didn't
    // say.
    if let Some(page) = &mut app.data.requests.value {
        let LedgerRecord::Request(r) = &mut page.rows[1].record;
        r.agent = None;
    }
    press(&mut app, KeyCode::Char('/'));
    typed(&mut app, "claude code");
    assert_eq!(app.feed().len(), 1);
    let LedgerRecord::Request(r) = &app.feed()[0].record;
    assert_eq!(r.agent.map(agent_title), Some("Claude Code"));
}

#[test]
fn esc_never_quits_and_q_and_ctrl_c_do() {
    let mut app = app(Page::Overview);
    press(&mut app, KeyCode::Esc);
    assert!(!app.quit);
    press(&mut app, KeyCode::Char('6'));
    assert_eq!(app.page, Page::Usage);
    press(&mut app, KeyCode::Esc);
    assert_eq!(app.page, Page::Overview);
    // A dialog or help closes on Esc, and the page stays.
    let mut usage = self::app(Page::Provider(Provider::Claude));
    press(&mut usage, KeyCode::Char(' '));
    press(&mut usage, KeyCode::Esc);
    assert!(usage.modal.is_none());
    assert_eq!(usage.page, Page::Provider(Provider::Claude));
    press(&mut usage, KeyCode::Char('?'));
    press(&mut usage, KeyCode::Esc);
    assert!(!usage.help);
    assert_eq!(usage.page, Page::Provider(Provider::Claude));
    assert!(!usage.quit);
    press(&mut app, KeyCode::Char('q'));
    assert!(app.quit);
}

#[test]
fn only_y_confirms_a_change_that_cannot_be_taken_back() {
    let mut app = app(Page::Provider(Provider::Codex));
    press(&mut app, KeyCode::Char('R'));
    assert_eq!(press(&mut app, KeyCode::Enter), []);
    assert!(app.modal.is_some(), "Enter leaves it up");
    assert_eq!(
        press(&mut app, KeyCode::Char('y')),
        [Cmd::Act(Action::Redeem("codex-fbfb76d8".into()))]
    );
    assert!(app.modal.is_none());
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
    let page: RequestPage = fixture("usage.requests.ok");
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
            strategy: Some(Strategy::FillFirst),
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
    assert_eq!(press(&mut app, KeyCode::Enter), []);
    assert_eq!(
        press(&mut app, KeyCode::Char('y')),
        [Cmd::Act(Action::RemoveKey("laptop".into()))]
    );
}

#[test]
fn typing_a_name_takes_no_control_keys() {
    let mut app = app(Page::Access);
    press(&mut app, KeyCode::Char('a'));
    typed(&mut app, "ci");
    app.key(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL));
    app.key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    let Some(Modal::Input { value, .. }) = &app.modal else {
        panic!("still typing: {:?}", app.modal);
    };
    assert_eq!(value, "ci");
}

#[test]
fn a_new_key_stays_up_until_esc_or_enter_and_c_copies_it() {
    let mut app = app(Page::Access);
    let key = NewKey {
        name: "ci".into(),
        key: "sk-slopmax-secret".into(),
        models: Vec::new(),
    };
    app.apply(Msg::Done(
        Action::MakeKey("ci".into()),
        Ok(Outcome::NewKey(key)),
    ));
    assert!(matches!(app.modal, Some(Modal::Secret { .. })));
    press(&mut app, KeyCode::Char('x'));
    press(&mut app, KeyCode::Down);
    assert!(app.modal.is_some(), "other keys leave it up");
    assert_eq!(
        press(&mut app, KeyCode::Char('c')),
        [Cmd::Copy("sk-slopmax-secret".into())]
    );
    assert!(app.modal.is_some(), "copying leaves it up");
    press(&mut app, KeyCode::Enter);
    assert!(app.modal.is_none());
}

#[test]
fn agents_connect_at_once_and_disconnect_after_asking() {
    let mut app = app(Page::Agents);
    // Claude Code is connected: `c` does nothing, `x` asks.
    assert_eq!(press(&mut app, KeyCode::Char('c')), []);
    press(&mut app, KeyCode::Char('x'));
    assert_eq!(press(&mut app, KeyCode::Enter), []);
    assert_eq!(
        press(&mut app, KeyCode::Char('y')),
        [Cmd::Act(Action::Disconnect(AgentId::ClaudeCode))]
    );
    press(&mut app, KeyCode::Down);
    assert_eq!(
        press(&mut app, KeyCode::Enter),
        [Cmd::Act(Action::Connect(AgentId::Codex))]
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
        Ok(Outcome::Report(
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
fn the_overview_lists_what_wants_a_look_before_the_pools() {
    let app = app(Page::Overview);
    let items = app.attention();
    assert_eq!(items.len(), 3);
    assert_eq!(app.rows(), items.len() + app.data.providers().len());
}

#[test]
fn enter_on_what_wants_a_look_opens_its_account() {
    let mut app = app(Page::Overview);
    // claude@example.com's 5-hour window runs out first.
    let cmds = press(&mut app, KeyCode::Enter);
    assert_eq!(app.page, Page::Provider(Provider::Claude));
    assert_eq!(cmds, [Cmd::Fetch(What::Pool(Provider::Claude))]);
    assert_eq!(
        app.selected_account().map(|a| a.name.as_str()),
        Some("claude@example.com")
    );
}

#[test]
fn r_on_what_wants_a_look_redeems_only_where_it_says_so() {
    let mut app = app(Page::Overview);
    // The first item is only to look at: R does nothing.
    assert_eq!(press(&mut app, KeyCode::Char('R')), []);
    assert!(app.modal.is_none());
    // The second is codex@example.com, limited and holding a reset.
    press(&mut app, KeyCode::Down);
    assert_eq!(
        app.selected_attention().map(|a| a.remedy),
        Some(crate::attention::Remedy::Redeem)
    );
    press(&mut app, KeyCode::Char('R'));
    let Some(Modal::Confirm { action, .. }) = &app.modal else {
        panic!("asks first: {:?}", app.modal);
    };
    assert_eq!(*action, Action::Redeem("codex-fbfb76d8".into()));
}

#[test]
fn the_overview_opens_the_selected_pool_after_what_wants_a_look() {
    let mut app = app(Page::Overview);
    let first = app.attention().len();
    for _ in 0..first + 1 {
        press(&mut app, KeyCode::Down);
    }
    press(&mut app, KeyCode::Enter);
    assert_eq!(app.page, Page::Provider(Provider::Codex));
}

#[test]
fn a_range_change_while_machines_load_fetches_the_new_range_and_keeps_each_apart() {
    let mut app = app(Page::Usage);
    app.data.machines = Default::default();
    let cmds = press(&mut app, KeyCode::Char('r'));
    assert_eq!(app.range, HistoryRange::Month);
    assert!(cmds.contains(&Cmd::Fetch(What::Machines(HistoryRange::Month))));
    // Month is still on its way; Today is asked all the same.
    let cmds = press(&mut app, KeyCode::Char('r'));
    assert_eq!(app.range, HistoryRange::Today);
    assert!(cmds.contains(&Cmd::Fetch(What::Machines(HistoryRange::Today))));
    let summary: Summary = fixture("usage.summary.machine.ok");
    app.apply(Msg::Fetched(Box::new(Fetched::Machines(
        HistoryRange::Month,
        Ok(summary),
    ))));
    assert!(app.data.machines(HistoryRange::Month).value.is_some());
    assert!(app.data.machines(HistoryRange::Today).value.is_none());
    assert!(app.data.machines(HistoryRange::Today).loading);
}

#[test]
fn reaching_slopmax_again_fetches_the_page_and_marks_the_rest_stale() {
    let mut app = app(Page::Overview);
    app.apply(Msg::Link(Link::Lost("refused".into())));
    let cmds = app.apply(Msg::Link(Link::Live("0.14.0".into())));
    assert_eq!(
        cmds,
        [
            Cmd::Fetch(What::History(HistoryRange::Today)),
            Cmd::Fetch(What::Latest),
            Cmd::Fetch(What::Settings),
        ]
    );
    assert!(app.data.agents.stale && app.data.keys.stale);
    assert!(app.data.history(HistoryRange::Week).stale);
}

#[test]
fn a_fetch_that_failed_before_the_stream_came_up_is_asked_again() {
    let mut app = App::new(None);
    let first = app.load();
    assert_eq!(first.len(), 3);
    app.apply(Msg::Fetched(Box::new(Fetched::Settings(Err(
        "refused".into()
    )))));
    // While slopmax isn't reached, nothing is asked again.
    let later = Clock::now() + Duration::from_secs(4);
    assert_eq!(app.tick(later), []);
    let cmds = app.apply(Msg::Link(Link::Live("0.14.0".into())));
    assert!(cmds.contains(&Cmd::Fetch(What::Settings)), "{cmds:?}");
    // And a failure once it is reached is tried again after a pause.
    app.apply(Msg::Fetched(Box::new(Fetched::Settings(
        Err("busy".into()),
    ))));
    assert!(app.tick(later).contains(&Cmd::Fetch(What::Settings)));
}

#[test]
fn a_dropped_answer_to_an_old_query_leaves_the_new_one_loading() {
    let mut app = app(Page::Requests);
    press(&mut app, KeyCode::Char('o'));
    assert!(app.data.requests.loading);
    app.apply(Msg::Fetched(Box::new(Fetched::Requests(
        RequestQuery::default(),
        Err("late".into()),
    ))));
    assert!(app.data.requests.loading);
}

fn request(status: u16, attempts: u32) -> LedgerRecord {
    let page: RequestPage = fixture("usage.requests.ok");
    let LedgerRecord::Request(record) = page.rows[0].record.clone();
    LedgerRecord::Request(RequestRecord {
        status,
        attempts,
        ..record
    })
}

#[test]
fn the_overview_s_latest_requests_ignore_the_feed_s_filters() {
    let mut app = app(Page::Overview);
    assert_eq!(
        app.load()
            .iter()
            .filter(|c| matches!(c, Cmd::Fetch(What::Requests(_))))
            .count(),
        0,
        "the overview doesn't ask with the feed's query"
    );
    app.data.query.outcome = RequestOutcome::Failed;
    let before = app.data.latest.value.as_ref().map_or(0, |p| p.matched);
    let feed = app.data.requests.value.as_ref().map_or(0, |p| p.matched);
    app.apply(Msg::Event(Box::new(Event::Request {
        record: request(200, 1),
    })));
    let latest = app.data.latest.value.as_ref().unwrap();
    assert_eq!(latest.matched, before + 1);
    assert!(latest.rows.len() <= crate::data::LATEST as usize);
    // The feed shows failures only, so it doesn't take it.
    assert_eq!(app.data.requests.value.as_ref().unwrap().matched, feed);
}

#[test]
fn a_request_answered_on_a_second_try_counts_as_rescued() {
    let mut app = app(Page::Requests);
    let page = app.data.requests.value.as_ref().unwrap();
    let (rescued, failed) = (page.rescued, page.failed);
    app.apply(Msg::Event(Box::new(Event::Request {
        record: request(200, 2),
    })));
    app.apply(Msg::Event(Box::new(Event::Request {
        record: request(529, 3),
    })));
    let page = app.data.requests.value.as_ref().unwrap();
    assert_eq!((page.rescued, page.failed), (rescued + 1, failed + 1));
}

#[test]
fn a_new_key_comes_before_help_and_one_key_is_made_at_a_time() {
    let mut app = app(Page::Access);
    press(&mut app, KeyCode::Char('a'));
    typed(&mut app, "ci");
    assert_eq!(
        press(&mut app, KeyCode::Enter),
        [Cmd::Act(Action::MakeKey("ci".into()))]
    );
    // Another isn't asked for while the first is on its way, so one
    // secret can't take the place of another.
    assert_eq!(press(&mut app, KeyCode::Char('a')), []);
    assert!(app.modal.is_none());
    // Help is up when the answer comes: the secret takes its place, and
    // keys reach the secret.
    press(&mut app, KeyCode::Char('?'));
    assert!(app.help);
    let key = NewKey {
        name: "ci".into(),
        key: "sk-slopmax-secret".into(),
        models: Vec::new(),
    };
    app.apply(Msg::Done(
        Action::MakeKey("ci".into()),
        Ok(Outcome::NewKey(key)),
    ));
    assert!(!app.help);
    assert!(matches!(app.modal, Some(Modal::Secret { .. })));
    press(&mut app, KeyCode::Char('x'));
    assert!(matches!(app.modal, Some(Modal::Secret { .. })));
    press(&mut app, KeyCode::Esc);
    assert!(app.modal.is_none());
    // A refusal lets the next be asked for too.
    press(&mut app, KeyCode::Char('a'));
    typed(&mut app, "ci");
    press(&mut app, KeyCode::Enter);
    assert!(app.making_key);
    app.apply(Msg::Done(
        Action::MakeKey("ci".into()),
        Err("A key named ci already exists".into()),
    ));
    assert!(!app.making_key);
    press(&mut app, KeyCode::Char('a'));
    assert!(matches!(app.modal, Some(Modal::Input { .. })));
}

/// A request answered at `at` (minutes past 12:00) with `model`.
fn answered(minutes: i64, model: &str) -> LedgerRecord {
    let LedgerRecord::Request(record) = request(200, 1);
    LedgerRecord::Request(RequestRecord {
        at: record.at + slopmax_common::time::SignedDuration::from_mins(minutes),
        model: Some(model.into()),
        ..record
    })
}

fn model_at(app: &App, row: usize) -> Option<String> {
    let LedgerRecord::Request(r) = &app.feed().get(row)?.record;
    r.model.clone()
}

#[test]
fn the_feed_s_selection_stays_on_its_request_as_others_come_in() {
    let mut app = app(Page::Requests);
    press(&mut app, KeyCode::Down);
    assert_eq!(model_at(&app, app.cursor).as_deref(), Some("gpt-6-sol"));
    app.scroll = 5;
    // One comes in above it: the selection and the view move down with
    // what they were on.
    app.apply(Msg::Event(Box::new(Event::Request {
        record: answered(5, "claude-sonnet-5-5"),
    })));
    assert_eq!(app.arrived, 1);
    assert_eq!(app.cursor, 2);
    assert_eq!(app.scroll, 6);
    assert_eq!(model_at(&app, app.cursor).as_deref(), Some("gpt-6-sol"));
    // At the top, the view stays there to watch them come in.
    app.scroll = 0;
    app.apply(Msg::Event(Box::new(Event::Request {
        record: answered(6, "claude-sonnet-5-5"),
    })));
    assert_eq!((app.cursor, app.scroll), (3, 0));
    // One the filter hides neither counts nor moves anything.
    app.filter = "gpt".into();
    app.cursor = 0;
    app.apply(Msg::Event(Box::new(Event::Request {
        record: answered(7, "claude-opus-5-5"),
    })));
    assert_eq!(app.arrived, 2);
    assert_eq!(app.cursor, 0);
    assert_eq!(model_at(&app, 0).as_deref(), Some("gpt-6-sol"));
    // Fetched again, the feed is found the request that was selected.
    app.filter.clear();
    app.cursor = app.feed().len() - 1;
    assert_eq!(model_at(&app, app.cursor).as_deref(), Some("gpt-6-sol"));
    app.scroll = 9;
    let query = app.data.query.clone();
    app.apply(Msg::Fetched(Box::new(Fetched::Requests(
        query,
        Ok(fixture("usage.requests.ok")),
    ))));
    assert_eq!(app.cursor, 1);
    assert_eq!(model_at(&app, app.cursor).as_deref(), Some("gpt-6-sol"));
    assert_eq!(app.scroll, 9 - 4 + 1);
}

#[test]
fn past_midnight_what_is_counted_by_the_day_is_fetched_again() {
    let mut app = app(Page::Usage);
    assert!(!app.new_day(20_000));
    assert!(!app.new_day(20_000));
    assert!(!app.data.history(HistoryRange::Today).stale);
    assert!(app.new_day(20_001));
    assert!(app.data.history(HistoryRange::Today).stale);
    assert!(app.data.machines(HistoryRange::Week).stale);
    assert!(app.data.latest.stale && app.data.requests.stale);
    let later = Clock::now() + Duration::from_secs(4);
    let cmds = app.tick(later);
    assert!(
        cmds.contains(&Cmd::Fetch(What::History(HistoryRange::Week))),
        "{cmds:?}"
    );
}

#[test]
fn a_new_report_leaves_the_selection_on_the_same_account() {
    let mut app = app(Page::Provider(Provider::Claude));
    press(&mut app, KeyCode::Down);
    let id = app.selected_account().map(|a| a.id.clone()).unwrap();
    // The same accounts in another order.
    let mut report = app.data.report.clone().unwrap();
    let claude: Vec<usize> = report
        .accounts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.provider == Provider::Claude)
        .map(|(i, _)| i)
        .collect();
    report.accounts.swap(claude[0], claude[1]);
    app.apply(Msg::Event(Box::new(Event::Status {
        report: Box::new(report),
    })));
    assert_eq!(app.cursor, 0);
    assert_eq!(
        press(&mut app, KeyCode::Char('p')),
        [Cmd::Act(Action::Pin(id))]
    );
}

#[test]
fn a_new_report_makes_open_settings_stale() {
    let mut app = app(Page::Settings);
    let report = app.data.report.clone().unwrap();
    app.apply(Msg::Event(Box::new(Event::Status {
        report: Box::new(report),
    })));
    assert!(app.data.settings.stale);
}

#[test]
fn a_long_request_scrolls_and_any_other_key_closes_it() {
    let mut app = app(Page::Requests);
    press(&mut app, KeyCode::Enter);
    assert!(matches!(app.modal, Some(Modal::Request { scroll: 0, .. })));
    press(&mut app, KeyCode::Down);
    assert!(matches!(app.modal, Some(Modal::Request { scroll: 1, .. })));
    press(&mut app, KeyCode::Up);
    press(&mut app, KeyCode::Up);
    assert!(matches!(app.modal, Some(Modal::Request { scroll: 0, .. })));
    press(&mut app, KeyCode::Char('x'));
    assert!(app.modal.is_none());
}
