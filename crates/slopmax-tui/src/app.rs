//! The screen's state and what keys and the mouse do to it. Nothing here
//! draws or talks to the daemon: a key gives back the fetches and changes
//! it asks for, which the event loop sends, so every key can be tested.

use std::time::{Duration, Instant as Clock};

use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use slopmax_client::RequestQuery;
use slopmax_client::api::events::Event;
use slopmax_client::api::ledger::{
    HistoryRange, LedgerRecord, RequestOutcome, RequestRecord, RequestRow,
};
use slopmax_client::api::report::{AccountView, Condition, Note};
use slopmax_client::api::settings::{LIVE, LiveKind, LivePatch, LiveValue};
use slopmax_client::api::{Instant, NoticeKind, Provider, Strategy, Tone};
use slopmax_common::time::SignedDuration;

use crate::attention::{Attention, Remedy, attention};
use crate::data::{Action, Data, Fetched, Link, Msg, Outcome, What, range_index};
use crate::format::{Now, agent_title};

/// A page of the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Overview,
    Provider(Provider),
    Usage,
    Performance,
    Requests,
    Agents,
    Access,
    Diagnostics,
    Settings,
}

impl Page {
    pub fn title(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Provider(p) => p.title(),
            Self::Usage => "Usage",
            Self::Performance => "Performance",
            Self::Requests => "Requests",
            Self::Agents => "Agents",
            Self::Access => "Access",
            Self::Diagnostics => "Diagnostics",
            Self::Settings => "Settings",
        }
    }
}

/// What the event loop is asked to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    Fetch(What),
    Act(Action),
    /// Text for the terminal to put on the clipboard (OSC 52).
    Copy(String),
}

/// A dialog over the page.
#[derive(Debug, Clone, PartialEq)]
pub enum Modal {
    /// A change that can't be taken back, asked first.
    Confirm {
        title: String,
        body: String,
        yes: String,
        action: Action,
    },
    /// A line of text: a number of minutes, or a key's name.
    Input {
        title: String,
        hint: String,
        value: String,
        input: Input,
    },
    /// How new sessions pick an account.
    Strategy { selected: usize },
    /// Something shown once: a new key's secret. Only Esc or Enter close
    /// it, and the mouse is the terminal's while it shows, so the text can
    /// be selected.
    Secret {
        title: String,
        text: String,
        note: String,
    },
    /// One request of the feed, in full, scrolled by `scroll` fields
    /// where the screen is too short for all of them.
    Request { row: Box<RequestRow>, scroll: u16 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// A live setting's minutes, by its API name.
    Minutes(&'static str),
    KeyName,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Toast {
    pub text: String,
    pub tone: Tone,
    pub until: Clock,
}

/// Where the mouse can click, as the last frame drew it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    Page(usize),
    Row(usize),
    Range(HistoryRange),
    Outcome(RequestOutcome),
}

pub const RANGES: [HistoryRange; 3] =
    [HistoryRange::Today, HistoryRange::Week, HistoryRange::Month];
pub const OUTCOMES: [RequestOutcome; 4] = [
    RequestOutcome::All,
    RequestOutcome::Answered,
    RequestOutcome::Failed,
    RequestOutcome::Rescued,
];

pub fn range_title(range: HistoryRange) -> &'static str {
    match range {
        HistoryRange::Today => "Today",
        HistoryRange::Week => "7 days",
        HistoryRange::Month => "30 days",
    }
}

pub fn outcome_title(outcome: RequestOutcome) -> &'static str {
    match outcome {
        RequestOutcome::All => "All",
        RequestOutcome::Answered => "Answered",
        RequestOutcome::Failed => "Failed",
        RequestOutcome::Rescued => "Rescued",
    }
}

/// Below this many columns the sidebar folds away unless asked for.
pub const SIDEBAR_FROM: u16 = 100;

pub struct App {
    pub data: Data,
    pub page: Page,
    /// The selected row of the page, where it has rows.
    pub cursor: usize,
    /// How far the page is scrolled, in rows: the view, which the
    /// selection doesn't hold, so what lies past the last row can be read.
    pub scroll: u16,
    /// The selection just moved: the next frame scrolls it into view. A
    /// page opens at its top.
    pub follow: bool,
    /// The rows whose first line the last frame showed; `None` before a
    /// frame is drawn. A key that acts on the selection while it is out
    /// of view scrolls it in first.
    pub visible: Option<std::ops::Range<usize>>,
    /// The span Usage and Performance show.
    pub range: HistoryRange,
    /// Text the request feed is filtered by, and whether it is being typed.
    pub filter: String,
    pub filtering: bool,
    pub modal: Option<Modal>,
    pub help: bool,
    pub toasts: Vec<Toast>,
    /// The sidebar shown or hidden by `b`; by the width until then.
    pub sidebar: Option<bool>,
    pub quit: bool,
    pub suspend: bool,
    /// The hub this machine uses, by name, when it uses one.
    pub hub: Option<String>,
    /// Where the mouse can click, as the last frame drew it.
    pub hits: Vec<(Rect, Hit)>,
    /// The page just changed: the next frame brings it in.
    pub entered: bool,
    /// Requests that arrived since the last frame, which the feed brings in.
    pub arrived: usize,
    /// The last frame's width, for the sidebar and the page order.
    pub width: u16,
    /// How tall the page was laid out last frame, so the next is laid out
    /// on a canvas that tall at once.
    pub tall: u16,
    /// A new key was asked for and its answer hasn't come: another isn't
    /// asked for until it does, so one secret never hides another.
    pub making_key: bool,
    /// The local day the clock last ticked on, as days since 1970-01-01:
    /// what is counted by the day is fetched again once it turns.
    pub day: Option<i64>,
    /// The time keys act at, fixed in tests; the system's otherwise.
    pub frozen: Option<Instant>,
}

impl App {
    pub fn new(hub: Option<String>) -> Self {
        Self {
            data: Data::default(),
            page: Page::Overview,
            cursor: 0,
            scroll: 0,
            follow: false,
            visible: None,
            range: HistoryRange::Week,
            filter: String::new(),
            filtering: false,
            modal: None,
            help: false,
            toasts: Vec::new(),
            sidebar: None,
            quit: false,
            suspend: false,
            hub,
            hits: Vec::new(),
            entered: true,
            arrived: 0,
            width: 120,
            tall: 0,
            making_key: false,
            day: None,
            frozen: None,
        }
    }

    pub fn now(&self) -> Instant {
        self.frozen.unwrap_or_else(Instant::now)
    }

    /// Every page, in the sidebar's order.
    pub fn pages(&self) -> Vec<Page> {
        let mut pages = vec![Page::Overview];
        pages.extend(self.data.providers().into_iter().map(Page::Provider));
        pages.extend([
            Page::Usage,
            Page::Performance,
            Page::Requests,
            Page::Agents,
            Page::Access,
            Page::Diagnostics,
            Page::Settings,
        ]);
        pages
    }

    /// The pages a number key opens, `1` first: every page but the
    /// providers', whose count changes, so each number always opens the
    /// same page.
    pub fn numbered(&self) -> Vec<Page> {
        self.pages()
            .into_iter()
            .filter(|p| !matches!(p, Page::Provider(_)))
            .collect()
    }

    pub fn sidebar_shown(&self, width: u16) -> bool {
        self.sidebar.unwrap_or(width >= SIDEBAR_FROM)
    }

    /// Opens `page`, fetching what it shows.
    pub fn go(&mut self, page: Page) -> Vec<Cmd> {
        if page != self.page {
            self.page = page;
            self.cursor = 0;
            self.scroll = 0;
            self.follow = false;
            self.visible = None;
            self.filtering = false;
            self.entered = true;
        }
        self.load()
    }

    /// What the open page shows.
    fn wanted(&self) -> Vec<What> {
        match self.page {
            Page::Overview => vec![
                What::History(HistoryRange::Today),
                What::Latest,
                What::Settings,
            ],
            Page::Provider(p) if p.is_subscription() => vec![What::Pool(p)],
            Page::Provider(_) => Vec::new(),
            Page::Usage => vec![What::History(self.range), What::Machines(self.range)],
            Page::Performance => vec![What::History(self.range)],
            Page::Requests => vec![What::Requests(self.data.query.clone())],
            Page::Agents => vec![What::Agents],
            Page::Access => vec![What::Keys, What::Tailnet],
            Page::Diagnostics => vec![What::Doctor],
            Page::Settings => vec![What::Settings],
        }
    }

    /// Fetches what the open page shows.
    pub fn load(&mut self) -> Vec<Cmd> {
        let mut wanted = self.wanted();
        wanted.retain(|what| self.begin(what));
        wanted.into_iter().map(Cmd::Fetch).collect()
    }

    /// Marks `what` as being fetched; false when it already is.
    fn begin(&mut self, what: &What) -> bool {
        let data = &mut self.data;
        macro_rules! start {
            ($slot:expr) => {{
                let slot = $slot;
                if slot.loading {
                    false
                } else {
                    slot.begin();
                    true
                }
            }};
        }
        match what {
            What::History(range) => start!(&mut data.history[range_index(*range)]),
            What::Pool(p) => start!(data.pools.entry(*p).or_default()),
            // A new query is asked at once; the answer to the one before
            // is dropped when it comes.
            What::Requests(_) => {
                data.requests.begin();
                true
            }
            What::Latest => start!(&mut data.latest),
            What::Machines(range) => start!(&mut data.machines[range_index(*range)]),
            What::Agents => start!(&mut data.agents),
            What::Doctor => start!(&mut data.doctor),
            What::Settings => start!(&mut data.settings),
            What::Keys => start!(&mut data.keys),
            What::Tailnet => start!(&mut data.tailnet),
        }
    }

    /// Once a second: toasts expire, and what the open page shows that
    /// changed since it was fetched, or failed, is fetched again while
    /// slopmax is reached.
    pub fn tick(&mut self, at: Clock) -> Vec<Cmd> {
        self.toasts.retain(|t| t.until > at);
        let now = self.now();
        self.new_day(
            Now {
                at: now,
                offset: now.local_offset(),
            }
            .today(),
        );
        if !matches!(self.data.link, Link::Live(_)) {
            return Vec::new();
        }
        let mut wanted = self.wanted();
        wanted.retain(|what| self.data.due(what, at));
        wanted.retain(|what| self.begin(what));
        wanted.into_iter().map(Cmd::Fetch).collect()
    }

    /// Notes the local day; past midnight, what is counted by the day
    /// (today's history and requests, the machines' shares, the ranges'
    /// days) is stale, and fetched again as its page is open. True when
    /// the day turned.
    pub fn new_day(&mut self, today: i64) -> bool {
        let turned = self.day.is_some_and(|day| day != today);
        self.day = Some(today);
        if turned {
            self.data.new_day();
        }
        turned
    }

    pub fn toast(&mut self, text: impl Into<String>, tone: Tone) {
        let seconds = if tone == Tone::Bad { 7 } else { 4 };
        self.toasts.push(Toast {
            text: text.into(),
            tone,
            until: Clock::now() + Duration::from_secs(seconds),
        });
        if self.toasts.len() > 3 {
            self.toasts.remove(0);
        }
    }

    /// Takes in a message from the daemon.
    pub fn apply(&mut self, msg: Msg) -> Vec<Cmd> {
        let at = Clock::now();
        match msg {
            Msg::Link(link) => {
                let was = std::mem::replace(&mut self.data.link, link);
                match (&was, &self.data.link) {
                    (Link::Live(_), Link::Lost(_)) => {
                        self.toast("Lost slopmax; trying again", Tone::Warn);
                    }
                    // Back after a break, or up after a start whose first
                    // fetches failed: whatever was fetched may be out of
                    // date, so the page is fetched again and the rest as
                    // each opens.
                    (Link::Lost(_), Link::Live(_)) => {
                        self.toast("Reached slopmax again", Tone::Good);
                        self.data.all_stale();
                        return self.load();
                    }
                    (Link::Connecting, Link::Live(_)) if self.data.any_error() => {
                        self.data.all_stale();
                        return self.load();
                    }
                    _ => {}
                }
            }
            Msg::Event(event) => match *event {
                Event::Status { report } => {
                    let picked = self.picked();
                    self.data.report = Some(*report);
                    if self.page != Page::Overview && !self.pages().contains(&self.page) {
                        return self.go(Page::Overview);
                    }
                    self.repick(picked);
                    if let Page::Provider(p) = self.page
                        && let Some(slot) = self.data.pools.get_mut(&p)
                    {
                        slot.stale = true;
                    }
                    // Settings shows the strategy the report just told the
                    // header, and the overview session affinity; the rest
                    // of the view may have moved with it.
                    if matches!(self.page, Page::Settings | Page::Overview) {
                        self.data.settings.stale = true;
                    }
                }
                Event::Request { record } => self.arrive(&record),
                Event::Notice { notice } => {
                    let tone = match notice.kind {
                        NoticeKind::Limited | NoticeKind::Exhausted | NoticeKind::SignedOut => {
                            Tone::Bad
                        }
                        NoticeKind::Available | NoticeKind::Recovered => Tone::Good,
                        _ => Tone::Warn,
                    };
                    self.toast(notice.message, tone);
                }
                Event::Hello { .. } | Event::Login { .. } | Event::Ping {} => {}
            },
            Msg::Fetched(fetched) => self.fetched(*fetched, at),
            Msg::Done(action, result) => return self.done(action, result),
        }
        Vec::new()
    }

    fn fetched(&mut self, fetched: Fetched, at: Clock) {
        let data = &mut self.data;
        match fetched {
            Fetched::History(range, r) => data.history[range_index(range)].finish(r, at),
            Fetched::Pool(p, r) => data.pools.entry(p).or_default().finish(r, at),
            Fetched::Requests(query, r) => {
                // An answer to a query since changed is dropped; the new
                // one is on its way, and still loading.
                if query == data.query {
                    let selected = self.selected_request();
                    self.data.requests.finish(r, at);
                    self.reselect_request(selected);
                }
            }
            Fetched::Latest(r) => data.latest.finish(r, at),
            Fetched::Machines(range, r) => data.machines[range_index(range)].finish(r, at),
            Fetched::Agents(r) => data.agents.finish(r, at),
            Fetched::Doctor(r) => data.doctor.finish(r, at),
            Fetched::Settings(r) => data.settings.finish(r, at),
            Fetched::Keys(r) => data.keys.finish(r, at),
            Fetched::Tailnet(r) => data.tailnet.finish(r, at),
        }
        self.clamp();
    }

    fn done(&mut self, action: Action, result: Result<Outcome, String>) -> Vec<Cmd> {
        if matches!(action, Action::MakeKey(_)) {
            self.making_key = false;
        }
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                self.toast(error, Tone::Bad);
                return Vec::new();
            }
        };
        match outcome {
            Outcome::Report(report, said) => {
                let picked = self.picked();
                self.data.report = Some(*report);
                self.repick(picked);
                self.toast(said, Tone::Good);
            }
            Outcome::Settings(view, said) => {
                self.data.settings.value = Some(*view);
                self.toast(said, Tone::Good);
            }
            Outcome::Keys(keys, said) => {
                self.data.keys.value = Some(keys);
                self.toast(said, Tone::Good);
            }
            Outcome::NewKey(key) => {
                // The secret shows this once, so it comes before anything
                // else that was up: help would hide it and take its keys.
                self.help = false;
                self.modal = Some(Modal::Secret {
                    title: format!("The key {:?}", key.name),
                    text: key.key,
                    note: "Shown this once. Clients present it as a bearer token or x-api-key."
                        .into(),
                });
                return self.load();
            }
            Outcome::Agent(said) => {
                self.toast(said, Tone::Good);
                if matches!(action, Action::Connect(_) | Action::Disconnect(_)) {
                    return self.load();
                }
            }
        }
        // A list that lost its last row leaves the selection on the row
        // now last.
        self.clamp();
        Vec::new()
    }

    /// What the selection is on, where the page's rows come from the
    /// report: a report that adds, drops or reorders rows above it leaves
    /// it on the same thing, so a key that acts at once acts on it.
    fn picked(&self) -> Option<Picked> {
        match self.page {
            Page::Overview => {
                let items = self.attention();
                match items.get(self.cursor) {
                    Some(item) => Some(Picked::Item(item.account.clone(), item.remedy)),
                    None => self
                        .data
                        .providers()
                        .get(self.cursor - items.len())
                        .copied()
                        .map(Picked::Pool),
                }
            }
            Page::Provider(_) => self
                .selected_account()
                .map(|account| Picked::Account(account.id.clone())),
            _ => None,
        }
    }

    /// Puts the selection back on what [`App::picked`] said it was on,
    /// where it still is.
    fn repick(&mut self, picked: Option<Picked>) {
        let found = match &picked {
            Some(Picked::Item(account, remedy)) => {
                let items = self.attention();
                items
                    .iter()
                    .position(|i| i.account == *account && i.remedy == *remedy)
                    .or_else(|| items.iter().position(|i| i.account == *account))
            }
            Some(Picked::Pool(provider)) => {
                let first = self.attention().len();
                self.data
                    .providers()
                    .iter()
                    .position(|p| p == provider)
                    .map(|i| first + i)
            }
            Some(Picked::Account(id)) => self.accounts().iter().position(|a| a.id == *id),
            None => None,
        };
        if let Some(at) = found {
            self.cursor = at;
        }
        self.clamp();
    }

    /// The feed's selected request, while the feed is open.
    fn selected_request(&self) -> Option<LedgerRecord> {
        if self.page != Page::Requests {
            return None;
        }
        self.feed().get(self.cursor).map(|row| row.record.clone())
    }

    /// Finds the request that was selected in a feed fetched again, and
    /// selects it there, the view moving with it.
    fn reselect_request(&mut self, selected: Option<LedgerRecord>) {
        let Some(LedgerRecord::Request(was)) = selected else {
            return;
        };
        let found = self.feed().iter().position(|row| {
            let LedgerRecord::Request(r) = &row.record;
            same_request(r, &was)
        });
        let Some(at) = found else {
            return;
        };
        if self.scroll > 0 {
            let moved = (at as isize - self.cursor as isize).clamp(-4096, 4096);
            self.scroll = self.scroll.saturating_add_signed(moved as i16);
        }
        self.cursor = at;
    }

    /// Takes in a request the daemon just answered. On the feed, a request
    /// that comes in above the selection leaves it on the row it was on,
    /// and the view on what it showed, unless the view is at the top,
    /// where new requests are watched coming in.
    fn arrive(&mut self, record: &LedgerRecord) {
        let had = self.page == Page::Requests && !self.feed().is_empty();
        if !self.data.record(record) {
            return;
        }
        let needle = self.filter.to_lowercase();
        let row = RequestRow {
            record: record.clone(),
            cost: None,
            end: None,
        };
        if !needle.is_empty() && !self.matches(&row, &needle) {
            return;
        }
        self.arrived += 1;
        if had {
            self.cursor += 1;
            if self.scroll > 0 {
                self.scroll = self.scroll.saturating_add(1);
            }
            self.clamp();
        }
    }

    /// The accounts of the provider page that is open.
    pub fn accounts(&self) -> Vec<&AccountView> {
        let (Page::Provider(p), Some(report)) = (self.page, &self.data.report) else {
            return Vec::new();
        };
        report.accounts.iter().filter(|a| a.provider == p).collect()
    }

    /// The feed's rows the filter lets through.
    pub fn feed(&self) -> Vec<&RequestRow> {
        let Some(page) = &self.data.requests.value else {
            return Vec::new();
        };
        let needle = self.filter.to_lowercase();
        page.rows
            .iter()
            .filter(|row| needle.is_empty() || self.matches(row, &needle))
            .collect()
    }

    fn matches(&self, row: &RequestRow, needle: &str) -> bool {
        let LedgerRecord::Request(r) = &row.record;
        let account = r.account.as_deref().map(|id| self.data.account_name(id));
        [
            r.model.as_deref(),
            account,
            r.agent.map(agent_title),
            r.machine.as_deref(),
            r.session.as_deref(),
        ]
        .into_iter()
        .flatten()
        .chain(std::iter::once(r.provider.title()))
        .any(|text| text.to_lowercase().contains(needle))
    }

    /// What wants a look, as the overview lists it: its first rows.
    pub fn attention(&self) -> Vec<Attention> {
        let Some(report) = &self.data.report else {
            return Vec::new();
        };
        // Only which items there are is read here, not their clock times.
        let now = Now {
            at: self.now(),
            offset: SignedDuration::ZERO,
        };
        attention(report, &now)
    }

    /// The overview's selected item of what wants a look, if one is.
    pub fn selected_attention(&self) -> Option<Attention> {
        if self.page != Page::Overview {
            return None;
        }
        self.attention().into_iter().nth(self.cursor)
    }

    /// The selected account of a provider page.
    pub fn selected_account(&self) -> Option<&AccountView> {
        self.accounts().get(self.cursor).copied()
    }

    /// How many rows the open page has to select.
    pub fn rows(&self) -> usize {
        match self.page {
            Page::Overview => self.attention().len() + self.data.providers().len(),
            Page::Provider(_) => self.accounts().len(),
            Page::Requests => self.feed().len(),
            Page::Agents => self.data.agents.value.as_ref().map_or(0, Vec::len),
            Page::Access => self.data.keys.value.as_ref().map_or(0, Vec::len),
            Page::Settings => LIVE.len(),
            Page::Usage | Page::Performance | Page::Diagnostics => 0,
        }
    }

    fn clamp(&mut self) {
        let rows = self.rows();
        self.cursor = self.cursor.min(rows.saturating_sub(1));
    }

    fn page_index(&self) -> usize {
        self.pages()
            .iter()
            .position(|p| *p == self.page)
            .unwrap_or(0)
    }

    fn step_page(&mut self, by: isize) -> Vec<Cmd> {
        let pages = self.pages();
        let at = self.page_index() as isize + by;
        let at = at.rem_euclid(pages.len() as isize) as usize;
        self.go(pages[at])
    }

    /// Moves the selection by `by` rows; past the first or last row, or on
    /// a page without rows, the view scrolls instead.
    fn step(&mut self, by: isize) {
        let rows = self.rows();
        if rows > 0 {
            let to = (self.cursor as isize + by).clamp(0, rows as isize - 1) as usize;
            if to != self.cursor {
                self.cursor = to;
                self.follow = true;
                return;
            }
        }
        self.scroll_by(by);
    }

    /// Scrolls the view, leaving the selection where it is.
    fn scroll_by(&mut self, by: isize) {
        let by = by.clamp(i16::MIN.into(), i16::MAX.into()) as i16;
        self.scroll = self.scroll.saturating_add_signed(by);
        self.follow = false;
    }

    /// What a key does.
    pub fn key(&mut self, key: KeyEvent) -> Vec<Cmd> {
        if key.kind == KeyEventKind::Release {
            return Vec::new();
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('c') if ctrl => {
                self.quit = true;
                return Vec::new();
            }
            KeyCode::Char('z') if ctrl => {
                self.suspend = true;
                return Vec::new();
            }
            _ => {}
        }
        if self.modal.is_some() {
            return self.modal_key(key);
        }
        if self.help {
            self.help = false;
            return Vec::new();
        }
        if self.filtering {
            match key.code {
                KeyCode::Esc => {
                    self.filtering = false;
                    self.filter.clear();
                }
                KeyCode::Enter | KeyCode::Down | KeyCode::Up => self.filtering = false,
                KeyCode::Backspace => {
                    self.filter.pop();
                }
                KeyCode::Char(c) if !ctrl => self.filter.push(c),
                _ => {}
            }
            self.clamp();
            return Vec::new();
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            // Esc backs out, and never quits: a filter first, then the page.
            KeyCode::Esc if self.page == Page::Requests && !self.filter.is_empty() => {
                self.filter.clear();
                self.clamp();
            }
            KeyCode::Esc if self.page != Page::Overview => return self.go(Page::Overview),
            KeyCode::Esc => {}
            KeyCode::Char('?') => self.help = true,
            KeyCode::Char('r') if ctrl => {
                let mut cmds = self.load();
                cmds.push(Cmd::Act(Action::Refresh));
                return cmds;
            }
            KeyCode::F(5) => return self.load(),
            KeyCode::Tab | KeyCode::Right | KeyCode::Char('l') => return self.step_page(1),
            KeyCode::BackTab | KeyCode::Left | KeyCode::Char('h') => return self.step_page(-1),
            KeyCode::Char(c @ '1'..='9') => {
                let pages = self.numbered();
                if let Some(page) = pages.get(c as usize - '1' as usize) {
                    return self.go(*page);
                }
            }
            KeyCode::Up | KeyCode::Char('k') => self.step(-1),
            KeyCode::Down | KeyCode::Char('j') => self.step(1),
            KeyCode::PageUp => self.step(-10),
            KeyCode::PageDown => self.step(10),
            KeyCode::Home | KeyCode::Char('g') => {
                self.cursor = 0;
                self.scroll = 0;
                self.follow = false;
            }
            // The last row, and the page's bottom, which may lie below it.
            KeyCode::End | KeyCode::Char('G') => {
                self.cursor = self.rows().saturating_sub(1);
                self.scroll = u16::MAX;
                self.follow = false;
            }
            KeyCode::Char('b') => {
                let shown = self.sidebar_shown(self.width);
                self.sidebar = Some(!shown);
            }
            _ => return self.page_key(key),
        }
        Vec::new()
    }

    fn page_key(&mut self, key: KeyEvent) -> Vec<Cmd> {
        match (self.page, key.code) {
            (Page::Overview, KeyCode::Enter) => return self.open_overview_row(),
            (Page::Overview, KeyCode::Char('R')) => {
                if let Some(item) = self.selected_attention()
                    && item.remedy == Remedy::Redeem
                    && let Some(account) = self.data.account(&item.account).cloned()
                {
                    // As on every page: a row out of view comes into view
                    // first, and the next press acts.
                    if self.unseen() {
                        return Vec::new();
                    }
                    self.ask_redeem(&account);
                }
            }
            (Page::Provider(_), _) => return self.account_key(key.code),
            (Page::Usage | Page::Performance, KeyCode::Char('r')) => {
                self.range = next(&RANGES, self.range);
                return self.load();
            }
            (Page::Requests, KeyCode::Char('r')) => {
                let range = next(&RANGES, self.data.query.range);
                return self.ask(|q| q.range = range);
            }
            (Page::Requests, KeyCode::Char('o')) => {
                let outcome = next(&OUTCOMES, self.data.query.outcome);
                return self.ask(|q| q.outcome = outcome);
            }
            (Page::Requests, KeyCode::Char('/')) => self.filtering = true,
            (Page::Requests, KeyCode::Enter) => {
                if let Some(row) = self.feed().get(self.cursor) {
                    self.modal = Some(Modal::Request {
                        row: Box::new((*row).clone()),
                        scroll: 0,
                    });
                }
            }
            (Page::Agents, code) => return self.agent_key(code),
            (Page::Access, KeyCode::Char('a')) if self.making_key => {
                self.toast("Still making the last key", Tone::Warn);
            }
            (Page::Access, KeyCode::Char('a')) => {
                self.modal = Some(Modal::Input {
                    title: "New client key".into(),
                    hint: "A name for the machine or tool that will use it".into(),
                    value: String::new(),
                    input: Input::KeyName,
                });
            }
            (Page::Access, KeyCode::Char('x') | KeyCode::Delete) => {
                let key = self
                    .data
                    .keys
                    .value
                    .as_ref()
                    .and_then(|keys| keys.get(self.cursor));
                if let Some(key) = key.cloned() {
                    if self.unseen() {
                        return Vec::new();
                    }
                    self.modal = Some(Modal::Confirm {
                        title: format!("Revoke the key {:?}?", key.name),
                        body: "Whatever uses it stops reaching the proxy at once.".into(),
                        yes: "Revoke".into(),
                        action: Action::RemoveKey(key.name.clone()),
                    });
                }
            }
            (Page::Settings, KeyCode::Enter | KeyCode::Char(' ')) => return self.setting_key(),
            _ => {}
        }
        Vec::new()
    }

    /// Changes the feed's query and asks for it. The rows of the query
    /// before answer something else, so they go at once: the feed reads
    /// as loading, or as the new query's failure, until its answer comes.
    fn ask(&mut self, change: impl FnOnce(&mut RequestQuery)) -> Vec<Cmd> {
        let was = self.data.query.clone();
        change(&mut self.data.query);
        if self.data.query != was {
            self.data.requests.value = None;
            self.data.requests.error = None;
            self.cursor = 0;
            self.scroll = 0;
            self.follow = false;
        }
        self.load()
    }

    /// Whether the selection is out of view, as the last frame drew the
    /// page: a key that acts on it scrolls it in instead, so nothing is
    /// changed on a row that can't be seen.
    fn unseen(&mut self) -> bool {
        let hidden = self
            .visible
            .as_ref()
            .is_some_and(|rows| !rows.contains(&self.cursor));
        if hidden {
            self.follow = true;
        }
        hidden
    }

    /// Opens what the overview's selected row is about: an item that wants
    /// a look opens its provider's page with its account selected; a pool
    /// opens its page.
    fn open_overview_row(&mut self) -> Vec<Cmd> {
        let items = self.attention();
        if let Some(item) = items.get(self.cursor) {
            let cmds = self.go(Page::Provider(item.provider));
            if let Some(i) = self.accounts().iter().position(|a| a.id == item.account) {
                self.cursor = i;
                self.follow = true;
            }
            return cmds;
        }
        match self.data.providers().get(self.cursor - items.len()) {
            Some(p) => self.go(Page::Provider(*p)),
            None => Vec::new(),
        }
    }

    /// Asks before redeeming one of `account`'s limit resets; says so when
    /// it holds none.
    fn ask_redeem(&mut self, account: &AccountView) {
        let held = held_resets(account, self.now());
        if held == 0 {
            self.toast(format!("{} holds no limit reset", account.name), Tone::Warn);
            return;
        }
        let spends = if held == 1 {
            "the one it holds".to_owned()
        } else {
            format!("one of the {held} it holds; the one closest to expiring goes first")
        };
        self.modal = Some(Modal::Confirm {
            title: format!("Redeem a limit reset on {}?", account.name),
            body: format!("It resets the account's usage windows at once and spends {spends}."),
            yes: "Redeem".into(),
            action: Action::Redeem(account.id.clone()),
        });
    }

    fn account_key(&mut self, code: KeyCode) -> Vec<Cmd> {
        let acts = matches!(code, KeyCode::Char(' ' | 'e' | 'p' | 'c' | 'R'));
        if acts && self.selected_account().is_some() && self.unseen() {
            return Vec::new();
        }
        let accounts = self.accounts();
        let Some(account) = accounts.get(self.cursor).map(|a| (*a).clone()) else {
            return Vec::new();
        };
        let pinned = accounts.iter().any(|a| a.pinned);
        let action = match code {
            KeyCode::Char(' ') | KeyCode::Char('e') if account.disabled => {
                Action::Enable(account.id.clone())
            }
            KeyCode::Char(' ') | KeyCode::Char('e') => {
                self.modal = Some(Modal::Confirm {
                    title: format!("Turn {} off?", account.name),
                    body: "slopmax stops routing to it; its sign-in is still kept fresh.".into(),
                    yes: "Turn off".into(),
                    action: Action::Disable(account.id.clone()),
                });
                return Vec::new();
            }
            KeyCode::Char('p') => Action::Pin(account.id.clone()),
            KeyCode::Char('a') if pinned => Action::UnpinAll,
            KeyCode::Char('c') => Action::Check(account.id.clone()),
            KeyCode::Char('R') => {
                self.ask_redeem(&account);
                return Vec::new();
            }
            _ => return Vec::new(),
        };
        vec![Cmd::Act(action)]
    }

    fn agent_key(&mut self, code: KeyCode) -> Vec<Cmd> {
        let Some(agent) = self
            .data
            .agents
            .value
            .as_ref()
            .and_then(|agents| agents.get(self.cursor))
            .cloned()
        else {
            return Vec::new();
        };
        if matches!(code, KeyCode::Enter | KeyCode::Char('c' | 'x')) && self.unseen() {
            return Vec::new();
        }
        match code {
            KeyCode::Enter | KeyCode::Char('c') if !agent.wired => {
                vec![Cmd::Act(Action::Connect(agent.id))]
            }
            KeyCode::Char('x') if agent.wired => {
                self.modal = Some(Modal::Confirm {
                    title: format!("Disconnect {}?", agent.title),
                    body: format!(
                        "Puts {} back as it was before slopmax; {} then talks to its provider directly.",
                        agent.config_path, agent.title
                    ),
                    yes: "Disconnect".into(),
                    action: Action::Disconnect(agent.id),
                });
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn setting_key(&mut self) -> Vec<Cmd> {
        let Some(live) = LIVE.get(self.cursor) else {
            return Vec::new();
        };
        if self.data.settings.value.is_some() && self.unseen() {
            return Vec::new();
        }
        let Some(view) = &self.data.settings.value else {
            return Vec::new();
        };
        let current = view.settings.live.get(live.name);
        match (live.kind, current) {
            (LiveKind::Switch, Some(LiveValue::Switch(on))) => {
                let patch = LivePatch::parse(live.name, if on { "off" } else { "on" });
                match patch {
                    Ok(patch) => vec![Cmd::Act(Action::Settings(patch))],
                    Err(e) => {
                        self.toast(e, Tone::Bad);
                        Vec::new()
                    }
                }
            }
            (LiveKind::Minutes, current) => {
                let value = current.map(|v| v.text()).unwrap_or_default();
                self.modal = Some(Modal::Input {
                    title: setting_title(live.name).into(),
                    hint: live.summary.into(),
                    value,
                    input: Input::Minutes(live.name),
                });
                Vec::new()
            }
            (LiveKind::Choice, _) => {
                let selected = Strategy::ALL
                    .iter()
                    .position(|s| *s == view.settings.live.strategy)
                    .unwrap_or(0);
                self.modal = Some(Modal::Strategy { selected });
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn modal_key(&mut self, key: KeyEvent) -> Vec<Cmd> {
        let Some(modal) = self.modal.take() else {
            return Vec::new();
        };
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match modal {
            // Every change asked first can't be taken back, so only `y`
            // makes it: Enter, pressed out of habit, doesn't.
            Modal::Confirm { action, .. } if key.code == KeyCode::Char('y') => {
                vec![Cmd::Act(action)]
            }
            Modal::Confirm { .. } if matches!(key.code, KeyCode::Char('n') | KeyCode::Esc) => {
                Vec::new()
            }
            Modal::Strategy { selected } => match key.code {
                KeyCode::Esc => Vec::new(),
                KeyCode::Up | KeyCode::Char('k') => {
                    self.modal = Some(Modal::Strategy {
                        selected: selected.saturating_sub(1),
                    });
                    Vec::new()
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.modal = Some(Modal::Strategy {
                        selected: (selected + 1).min(Strategy::ALL.len() - 1),
                    });
                    Vec::new()
                }
                KeyCode::Enter | KeyCode::Char(' ') => {
                    let patch = LivePatch {
                        strategy: Some(Strategy::ALL[selected]),
                        ..Default::default()
                    };
                    vec![Cmd::Act(Action::Settings(patch))]
                }
                _ => {
                    self.modal = Some(Modal::Strategy { selected });
                    Vec::new()
                }
            },
            Modal::Input {
                title,
                hint,
                mut value,
                input,
            } => {
                match key.code {
                    KeyCode::Esc => return Vec::new(),
                    KeyCode::Enter => return self.submit(input, value.trim(), title, hint),
                    KeyCode::Backspace => {
                        value.pop();
                    }
                    KeyCode::Char(c) if !ctrl => value.push(c),
                    _ => {}
                }
                self.modal = Some(Modal::Input {
                    title,
                    hint,
                    value,
                    input,
                });
                Vec::new()
            }
            Modal::Secret { title, text, note } if key.code == KeyCode::Char('c') => {
                let cmds = vec![Cmd::Copy(text.clone())];
                self.toast("Sent the key to the terminal's clipboard", Tone::Good);
                self.modal = Some(Modal::Secret { title, text, note });
                cmds
            }
            Modal::Secret { .. } if matches!(key.code, KeyCode::Esc | KeyCode::Enter) => Vec::new(),
            // The arrows scroll a request too long for the screen; any
            // other key closes it.
            Modal::Request { row, scroll } => {
                let scroll = match key.code {
                    KeyCode::Up | KeyCode::Char('k') => scroll.saturating_sub(1),
                    KeyCode::Down | KeyCode::Char('j') => scroll.saturating_add(1),
                    KeyCode::PageUp => scroll.saturating_sub(10),
                    KeyCode::PageDown => scroll.saturating_add(10),
                    KeyCode::Home | KeyCode::Char('g') => 0,
                    KeyCode::End | KeyCode::Char('G') => u16::MAX,
                    _ => return Vec::new(),
                };
                self.modal = Some(Modal::Request { row, scroll });
                Vec::new()
            }
            other => {
                self.modal = Some(other);
                Vec::new()
            }
        }
    }

    /// Pasted text goes into whatever is being typed.
    pub fn paste(&mut self, text: &str) {
        let text = text.trim_end_matches(['\r', '\n']);
        if let Some(Modal::Input { value, .. }) = &mut self.modal {
            value.push_str(text);
        } else if self.filtering {
            self.filter.push_str(text);
            self.clamp();
        }
    }

    fn submit(&mut self, input: Input, value: &str, title: String, hint: String) -> Vec<Cmd> {
        match input {
            Input::Minutes(name) => match LivePatch::parse(name, value) {
                Ok(patch) => vec![Cmd::Act(Action::Settings(patch))],
                Err(e) => {
                    self.toast(e, Tone::Bad);
                    self.modal = Some(Modal::Input {
                        title,
                        hint,
                        value: value.to_owned(),
                        input,
                    });
                    Vec::new()
                }
            },
            Input::KeyName if value.is_empty() => {
                self.modal = Some(Modal::Input {
                    title,
                    hint,
                    value: String::new(),
                    input,
                });
                Vec::new()
            }
            Input::KeyName => {
                self.making_key = true;
                vec![Cmd::Act(Action::MakeKey(value.to_owned()))]
            }
        }
    }

    /// What the mouse does: a click opens a page or selects a row, and the
    /// wheel scrolls. With help up a click closes it, and with a dialog up
    /// the page underneath takes nothing.
    pub fn mouse(&mut self, event: MouseEvent) -> Vec<Cmd> {
        if self.help {
            if matches!(event.kind, MouseEventKind::Down(_)) {
                self.help = false;
            }
            return Vec::new();
        }
        if let Some(Modal::Request { scroll, .. }) = &mut self.modal {
            // The wheel scrolls a request too long for the screen; the
            // next frame keeps it to its last field.
            match event.kind {
                MouseEventKind::ScrollDown => *scroll = scroll.saturating_add(3),
                MouseEventKind::ScrollUp => *scroll = scroll.saturating_sub(3),
                _ => {}
            }
            return Vec::new();
        }
        if self.modal.is_some() {
            return Vec::new();
        }
        match event.kind {
            MouseEventKind::ScrollDown => self.scroll_by(3),
            MouseEventKind::ScrollUp => self.scroll_by(-3),
            MouseEventKind::Down(MouseButton::Left) => {
                let at = Position::new(event.column, event.row);
                let hit = self
                    .hits
                    .iter()
                    .rev()
                    .find(|(rect, _)| rect.contains(at))
                    .map(|(_, hit)| *hit);
                match hit {
                    Some(Hit::Page(i)) => {
                        if let Some(page) = self.pages().get(i) {
                            return self.go(*page);
                        }
                    }
                    Some(Hit::Row(i)) => {
                        if self.cursor == i && matches!(self.page, Page::Overview | Page::Requests)
                        {
                            return self.page_key(KeyEvent::from(KeyCode::Enter));
                        }
                        self.cursor = i.min(self.rows().saturating_sub(1));
                        self.follow = true;
                    }
                    Some(Hit::Range(range)) => {
                        if self.page == Page::Requests {
                            return self.ask(|q| q.range = range);
                        }
                        self.range = range;
                        return self.load();
                    }
                    Some(Hit::Outcome(outcome)) => return self.ask(|q| q.outcome = outcome),
                    None => {}
                }
            }
            _ => {}
        }
        Vec::new()
    }
}

/// What a selection is on, so it can be found again: an item of what
/// wants a look (its account, and what can be done about it), a pool, or
/// an account.
#[derive(Debug, Clone, PartialEq)]
enum Picked {
    Item(String, Remedy),
    Pool(Provider),
    Account(String),
}

/// Whether two records are of the same request: the ledger keeps no id, so
/// when it was answered, by what, for which session, and how.
fn same_request(a: &RequestRecord, b: &RequestRecord) -> bool {
    a.at == b.at
        && a.provider == b.provider
        && a.account == b.account
        && a.session == b.session
        && a.model == b.model
        && a.status == b.status
        && a.ms == b.ms
}

/// The item after `current`, wrapping.
fn next<T: Copy + PartialEq>(items: &[T], current: T) -> T {
    let at = items.iter().position(|i| *i == current).unwrap_or(0);
    items[(at + 1) % items.len()]
}

/// How many limit resets an account can still redeem: those listed, else
/// the count its usage reports.
pub fn held_resets(account: &AccountView, now: Instant) -> u64 {
    if !account.resets.is_empty() {
        return account.unexpired_resets(now).count() as u64;
    }
    account
        .notes
        .iter()
        .find_map(|n| match n {
            Note::Resets { count } => Some(*count),
            _ => None,
        })
        .unwrap_or(0)
}

/// Whether an account serves: on, and signed in.
pub fn serving(account: &AccountView) -> bool {
    !account.disabled && !matches!(account.condition, Condition::SignInNeeded { .. })
}

/// A live setting's title, as Settings lists it.
pub fn setting_title(name: &str) -> &'static str {
    match name {
        "strategy" => "Strategy",
        "sessionAffinity" => "Session affinity",
        "sessionMinutes" => "Session memory",
        "redeemExpiring" => "When one would expire unused",
        "redeemWhenExhausted" => "When every account is spent",
        "warmWindows" => "Warm ChatGPT windows",
        "paidOverflow" => "Paid overflow",
        "pollMinutes" => "Usage polls",
        "refreshTokens" => "Refresh sign-ins",
        "websockets" => "Codex WebSockets",
        _ => "Setting",
    }
}

/// The section of Settings a live setting is listed under.
pub fn setting_group(name: &str) -> &'static str {
    match name {
        "strategy" | "sessionAffinity" | "sessionMinutes" => "Routing",
        "redeemExpiring" | "redeemWhenExhausted" => "Limit resets",
        _ => "Advanced",
    }
}

#[cfg(test)]
mod tests;
