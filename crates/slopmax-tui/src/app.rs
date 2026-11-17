//! The screen's state and what keys and the mouse do to it. Nothing here
//! draws or talks to the daemon: a key gives back the fetches and changes
//! it asks for, which the event loop sends, so every key can be tested.

use std::time::{Duration, Instant as Clock};

use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use slopmax_client::api::events::Event;
use slopmax_client::api::ledger::{HistoryRange, RequestOutcome, RequestRow};
use slopmax_client::api::report::{AccountView, Condition};
use slopmax_client::api::settings::{LIVE, LiveKind, LivePatch};
use slopmax_client::api::{Provider, Strategy, Tone};

use crate::data::{Action, Data, Fetched, Link, Msg, Outcome, What, range_index};

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
    /// Something shown once: a new key's secret.
    Secret {
        title: String,
        text: String,
        note: String,
    },
    /// One request of the feed, in full.
    Request(Box<RequestRow>),
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
    /// How far the page is scrolled, in rows.
    pub scroll: u16,
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
    /// The time keys act at, fixed in tests; the system's otherwise.
    pub frozen: Option<slopmax_client::api::Instant>,
}

impl App {
    pub fn new(hub: Option<String>) -> Self {
        Self {
            data: Data::default(),
            page: Page::Overview,
            cursor: 0,
            scroll: 0,
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
            frozen: None,
        }
    }

    pub fn now(&self) -> slopmax_client::api::Instant {
        self.frozen
            .unwrap_or_else(slopmax_client::api::Instant::now)
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

    pub fn sidebar_shown(&self, width: u16) -> bool {
        self.sidebar.unwrap_or(width >= SIDEBAR_FROM)
    }

    /// Opens `page`, fetching what it shows.
    pub fn go(&mut self, page: Page) -> Vec<Cmd> {
        if page != self.page {
            self.page = page;
            self.cursor = 0;
            self.scroll = 0;
            self.filtering = false;
            self.entered = true;
        }
        self.load()
    }

    /// Fetches what the open page shows.
    pub fn load(&mut self) -> Vec<Cmd> {
        let mut wanted = match self.page {
            Page::Overview => vec![
                What::History(HistoryRange::Today),
                What::Requests(self.data.query.clone()),
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
        };
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
            What::Machines(_) => start!(&mut data.machines),
            What::Agents => start!(&mut data.agents),
            What::Doctor => start!(&mut data.doctor),
            What::Settings => start!(&mut data.settings),
            What::Keys => start!(&mut data.keys),
            What::Tailnet => start!(&mut data.tailnet),
        }
    }

    /// Once a second: toasts expire, and what the open page shows that
    /// changed since it was fetched is fetched again.
    pub fn tick(&mut self, at: Clock) -> Vec<Cmd> {
        self.toasts.retain(|t| t.until > at);
        let mut wanted = Vec::new();
        match self.page {
            Page::Overview => {
                if self.data.history(HistoryRange::Today).due(at) {
                    wanted.push(What::History(HistoryRange::Today));
                }
                if self.data.requests.due(at) {
                    wanted.push(What::Requests(self.data.query.clone()));
                }
            }
            Page::Provider(p) => {
                if self.data.pool(p).is_some_and(|s| s.due(at)) {
                    wanted.push(What::Pool(p));
                }
            }
            Page::Usage | Page::Performance => {
                if self.data.history(self.range).due(at) {
                    wanted.push(What::History(self.range));
                }
                if self.page == Page::Usage && self.data.machines.due(at) {
                    wanted.push(What::Machines(self.range));
                }
            }
            Page::Requests if self.data.requests.due(at) => {
                wanted.push(What::Requests(self.data.query.clone()));
            }
            _ => {}
        }
        wanted.retain(|what| self.begin(what));
        wanted.into_iter().map(Cmd::Fetch).collect()
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
                if let Link::Lost(_) = &link
                    && matches!(self.data.link, Link::Live(_))
                {
                    self.toast("Lost slopmax; trying again", Tone::Warn);
                }
                self.data.link = link;
            }
            Msg::Event(event) => match *event {
                Event::Status { report } => {
                    let before = self.pages();
                    self.data.report = Some(*report);
                    if self.page != Page::Overview && !self.pages().contains(&self.page) {
                        return self.go(Page::Overview);
                    }
                    if before != self.pages() {
                        self.clamp();
                    }
                    if let Page::Provider(p) = self.page
                        && let Some(slot) = self.data.pools.get_mut(&p)
                    {
                        slot.stale = true;
                    }
                }
                Event::Request { record } => {
                    if self.data.record(&record) {
                        self.arrived += 1;
                    }
                }
                Event::Notice { notice } => {
                    let tone = match notice.kind {
                        slopmax_client::api::NoticeKind::Limited
                        | slopmax_client::api::NoticeKind::Exhausted
                        | slopmax_client::api::NoticeKind::SignedOut => Tone::Bad,
                        slopmax_client::api::NoticeKind::Available
                        | slopmax_client::api::NoticeKind::Recovered => Tone::Good,
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
                // one is on its way.
                if query == data.query {
                    data.requests.finish(r, at);
                } else {
                    data.requests.loading = false;
                }
            }
            Fetched::Machines(r) => data.machines.finish(r, at),
            Fetched::Agents(r) => data.agents.finish(r, at),
            Fetched::Doctor(r) => data.doctor.finish(r, at),
            Fetched::Settings(r) => data.settings.finish(r, at),
            Fetched::Keys(r) => data.keys.finish(r, at),
            Fetched::Tailnet(r) => data.tailnet.finish(r, at),
        }
        self.clamp();
    }

    fn done(&mut self, action: Action, result: Result<Outcome, String>) -> Vec<Cmd> {
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                self.toast(error, Tone::Bad);
                return Vec::new();
            }
        };
        match outcome {
            Outcome::Report(report, said) => {
                self.data.report = Some(*report);
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
        Vec::new()
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
        let slopmax_client::api::ledger::LedgerRecord::Request(r) = &row.record;
        let account = r.account.as_deref().map(|id| self.data.account_name(id));
        [
            r.model.as_deref(),
            account,
            r.machine.as_deref(),
            r.session.as_deref(),
        ]
        .into_iter()
        .flatten()
        .chain(std::iter::once(r.provider.title()))
        .any(|text| text.to_lowercase().contains(needle))
    }

    /// How many rows the open page has to select.
    pub fn rows(&self) -> usize {
        match self.page {
            Page::Overview => self.data.providers().len(),
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

    fn step(&mut self, by: isize) {
        let rows = self.rows();
        if rows == 0 {
            self.scroll = self.scroll.saturating_add_signed(by as i16);
            return;
        }
        self.cursor = (self.cursor as isize + by).clamp(0, rows as isize - 1) as usize;
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
            KeyCode::Esc if self.page == Page::Requests && !self.filter.is_empty() => {
                self.filter.clear();
                self.clamp();
            }
            KeyCode::Esc => self.quit = true,
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
                let pages = self.pages();
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
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.cursor = self.rows().saturating_sub(1);
                if self.rows() == 0 {
                    self.scroll = u16::MAX;
                }
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
            (Page::Overview, KeyCode::Enter) => {
                if let Some(p) = self.data.providers().get(self.cursor) {
                    return self.go(Page::Provider(*p));
                }
            }
            (Page::Provider(_), _) => return self.account_key(key.code),
            (Page::Usage | Page::Performance, KeyCode::Char('r')) => {
                self.range = next(&RANGES, self.range);
                return self.load();
            }
            (Page::Requests, KeyCode::Char('r')) => {
                self.data.query.range = next(&RANGES, self.data.query.range);
                return self.load();
            }
            (Page::Requests, KeyCode::Char('o')) => {
                self.data.query.outcome = next(&OUTCOMES, self.data.query.outcome);
                return self.load();
            }
            (Page::Requests, KeyCode::Char('/')) => self.filtering = true,
            (Page::Requests, KeyCode::Enter) => {
                if let Some(row) = self.feed().get(self.cursor) {
                    self.modal = Some(Modal::Request(Box::new((*row).clone())));
                }
            }
            (Page::Agents, code) => return self.agent_key(code),
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
                if let Some(key) = key {
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

    fn account_key(&mut self, code: KeyCode) -> Vec<Cmd> {
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
                let held = held_resets(&account, self.now());
                if held == 0 {
                    self.toast(format!("{} holds no limit reset", account.name), Tone::Warn);
                    return Vec::new();
                }
                self.modal = Some(Modal::Confirm {
                    title: format!("Redeem a limit reset on {}?", account.name),
                    body: format!(
                        "It resets the account's usage windows at once and spends one of the {held} it holds; \
                         the one closest to expiring goes first."
                    ),
                    yes: "Redeem".into(),
                    action: Action::Redeem(account.id.clone()),
                });
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
        let Some(view) = &self.data.settings.value else {
            return Vec::new();
        };
        let current = view.settings.live.get(live.name);
        match (live.kind, current) {
            (LiveKind::Switch, Some(slopmax_client::api::settings::LiveValue::Switch(on))) => {
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
        match modal {
            Modal::Confirm { action, .. }
                if matches!(key.code, KeyCode::Char('y') | KeyCode::Enter) =>
            {
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
                    KeyCode::Char(c) => value.push(c),
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
            Modal::Secret { .. } | Modal::Request(_) => Vec::new(),
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
            Input::KeyName => vec![Cmd::Act(Action::MakeKey(value.to_owned()))],
        }
    }

    /// What the mouse does: a click opens a page or selects a row, and the
    /// wheel moves the selection or scrolls.
    pub fn mouse(&mut self, event: MouseEvent) -> Vec<Cmd> {
        match event.kind {
            MouseEventKind::ScrollDown => self.step(if self.rows() == 0 { 3 } else { 1 }),
            MouseEventKind::ScrollUp => self.step(if self.rows() == 0 { -3 } else { -1 }),
            MouseEventKind::Down(MouseButton::Left) if self.modal.is_none() => {
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
                    }
                    Some(Hit::Range(range)) => {
                        if self.page == Page::Requests {
                            self.data.query.range = range;
                        } else {
                            self.range = range;
                        }
                        return self.load();
                    }
                    Some(Hit::Outcome(outcome)) => {
                        self.data.query.outcome = outcome;
                        return self.load();
                    }
                    None => {}
                }
            }
            _ => {}
        }
        Vec::new()
    }
}

/// The item after `current`, wrapping.
fn next<T: Copy + PartialEq>(items: &[T], current: T) -> T {
    let at = items.iter().position(|i| *i == current).unwrap_or(0);
    items[(at + 1) % items.len()]
}

/// How many limit resets an account can still redeem: those listed, else
/// the count its usage reports.
pub fn held_resets(account: &AccountView, now: slopmax_client::api::Instant) -> u64 {
    if !account.resets.is_empty() {
        return account.unexpired_resets(now).count() as u64;
    }
    account
        .notes
        .iter()
        .find_map(|n| match n {
            slopmax_client::api::report::Note::Resets { count } => Some(*count),
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
