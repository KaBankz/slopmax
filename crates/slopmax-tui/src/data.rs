//! What the terminal UI knows of the daemon: the report the event stream
//! pushes, each page's answers as last fetched, and the messages and
//! requests that move between the screen and the daemon.

use std::collections::BTreeMap;
use std::time::{Duration, Instant as Clock};

use slopmax_client::api::events::Event;
use slopmax_client::api::ledger::{
    History, HistoryRange, LedgerRecord, RequestOutcome, RequestPage, RequestRow, Summary,
    SummaryBy, SummaryRange,
};
use slopmax_client::api::pools::PoolDetail;
use slopmax_client::api::report::{AccountView, AgentWiring, RedeemOutcome, Report, Section};
use slopmax_client::api::requests::{AccountPatch, MakeKey, RedeemRequest};
use slopmax_client::api::settings::{KeyInfo, LivePatch, NewKey, SettingsView};
use slopmax_client::api::tailnet::TailnetView;
use slopmax_client::api::{AgentId, Provider};
use slopmax_client::{Client, RequestQuery};
use tokio::sync::mpsc::UnboundedSender;

/// One answer of the daemon's, as last fetched: kept on screen while it is
/// fetched again, so a page never blanks.
#[derive(Debug, Clone)]
pub struct Slot<T> {
    pub value: Option<T>,
    pub loading: bool,
    pub error: Option<String>,
    /// Something changed since it was fetched; fetched again once the page
    /// that shows it is open and a few seconds have passed.
    pub stale: bool,
    pub fetched: Option<Clock>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            value: None,
            loading: false,
            error: None,
            stale: false,
            fetched: None,
        }
    }
}

/// How long a stale answer waits before it is fetched again, so a burst of
/// requests is one fetch.
const SETTLE: Duration = Duration::from_secs(3);

impl<T> Slot<T> {
    pub fn begin(&mut self) {
        self.loading = true;
        self.stale = false;
    }

    /// Takes an answer in. A refusal or a failure is asked again once it
    /// settles, while its page is open.
    pub fn finish(&mut self, result: Result<T, String>, at: Clock) {
        self.loading = false;
        self.fetched = Some(at);
        match result {
            Ok(value) => {
                self.value = Some(value);
                self.error = None;
            }
            Err(error) => {
                self.error = Some(error);
                self.stale = true;
            }
        }
    }

    /// Stale, and settled long enough to fetch again.
    pub fn due(&self, at: Clock) -> bool {
        self.stale
            && !self.loading
            && self
                .fetched
                .is_none_or(|then| at.saturating_duration_since(then) >= SETTLE)
    }
}

/// Where the event stream stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Connecting,
    /// Following the stream of a slopmax of this version.
    Live(String),
    /// Lost, and why; it is tried again.
    Lost(String),
}

#[derive(Debug, Clone)]
pub struct Data {
    pub link: Link,
    pub report: Option<Report>,
    /// By range: today, 7 days, 30 days.
    pub history: [Slot<History>; 3],
    pub pools: BTreeMap<Provider, Slot<PoolDetail>>,
    /// The request feed, as Requests asks for it.
    pub requests: Slot<RequestPage>,
    /// The query `requests` answers.
    pub query: RequestQuery,
    /// The overview's latest requests: today's, whatever their outcome.
    pub latest: Slot<RequestPage>,
    /// The machines' share of each range, by range as `history` is.
    pub machines: [Slot<Summary>; 3],
    pub agents: Slot<Vec<AgentWiring>>,
    pub doctor: Slot<Vec<Section>>,
    pub settings: Slot<SettingsView>,
    pub keys: Slot<Vec<KeyInfo>>,
    pub tailnet: Slot<TailnetView>,
}

impl Default for Data {
    fn default() -> Self {
        Self {
            link: Link::Connecting,
            report: None,
            history: Default::default(),
            pools: BTreeMap::new(),
            requests: Slot::default(),
            query: RequestQuery::default(),
            latest: Slot::default(),
            machines: Default::default(),
            agents: Slot::default(),
            doctor: Slot::default(),
            settings: Slot::default(),
            keys: Slot::default(),
            tailnet: Slot::default(),
        }
    }
}

/// How many requests the overview lists.
pub const LATEST: u64 = 6;

/// The query of the overview's latest requests.
pub fn latest_query() -> RequestQuery {
    RequestQuery {
        range: HistoryRange::Today,
        outcome: RequestOutcome::All,
        limit: LATEST,
        ..RequestQuery::default()
    }
}

pub fn range_index(range: HistoryRange) -> usize {
    match range {
        HistoryRange::Today => 0,
        HistoryRange::Week => 1,
        HistoryRange::Month => 2,
    }
}

impl Data {
    pub fn history(&self, range: HistoryRange) -> &Slot<History> {
        &self.history[range_index(range)]
    }

    pub fn machines(&self, range: HistoryRange) -> &Slot<Summary> {
        &self.machines[range_index(range)]
    }

    pub fn pool(&self, provider: Provider) -> Option<&Slot<PoolDetail>> {
        self.pools.get(&provider)
    }

    /// An account by id, from the report.
    pub fn account(&self, id: &str) -> Option<&AccountView> {
        self.report.as_ref()?.accounts.iter().find(|a| a.id == id)
    }

    /// An account's name, by id; the id when the report doesn't know it.
    pub fn account_name<'a>(&'a self, id: &'a str) -> &'a str {
        self.account(id).map_or(id, |a| a.name.as_str())
    }

    /// The providers that have accounts, in the order requests try them.
    pub fn providers(&self) -> Vec<Provider> {
        let Some(report) = &self.report else {
            return Vec::new();
        };
        Provider::ALL
            .into_iter()
            .filter(|p| report.accounts.iter().any(|a| a.provider == *p))
            .collect()
    }

    /// Marks every answer stale, as after the stream was lost: each is
    /// fetched again once its page is open.
    pub fn all_stale(&mut self) {
        let Self {
            link: _,
            report: _,
            history,
            pools,
            requests,
            query: _,
            latest,
            machines,
            agents,
            doctor,
            settings,
            keys,
            tailnet,
        } = self;
        for slot in history.iter_mut() {
            slot.stale = true;
        }
        for slot in machines.iter_mut() {
            slot.stale = true;
        }
        for slot in pools.values_mut() {
            slot.stale = true;
        }
        requests.stale = true;
        latest.stale = true;
        agents.stale = true;
        doctor.stale = true;
        settings.stale = true;
        keys.stale = true;
        tailnet.stale = true;
    }

    /// Marks stale what is counted by the local day, as when it turns at
    /// midnight: the history of each range, the machines' shares, and the
    /// requests listed by range.
    pub fn new_day(&mut self) {
        for slot in &mut self.history {
            slot.stale = true;
        }
        for slot in &mut self.machines {
            slot.stale = true;
        }
        self.requests.stale = true;
        self.latest.stale = true;
    }

    /// Whether any answer is being fetched.
    pub fn any_loading(&self) -> bool {
        self.history.iter().any(|s| s.loading)
            || self.machines.iter().any(|s| s.loading)
            || self.pools.values().any(|s| s.loading)
            || self.requests.loading
            || self.latest.loading
            || self.agents.loading
            || self.doctor.loading
            || self.settings.loading
            || self.keys.loading
            || self.tailnet.loading
    }

    /// Whether any answer came back as an error.
    pub fn any_error(&self) -> bool {
        self.history.iter().any(|s| s.error.is_some())
            || self.machines.iter().any(|s| s.error.is_some())
            || self.pools.values().any(|s| s.error.is_some())
            || [&self.requests, &self.latest]
                .iter()
                .any(|s| s.error.is_some())
            || self.agents.error.is_some()
            || self.doctor.error.is_some()
            || self.settings.error.is_some()
            || self.keys.error.is_some()
            || self.tailnet.error.is_some()
    }

    /// Whether `what` is stale and settled long enough to fetch again.
    pub fn due(&self, what: &What, at: Clock) -> bool {
        match what {
            What::History(range) => self.history(*range).due(at),
            What::Pool(p) => self.pool(*p).is_some_and(|s| s.due(at)),
            What::Requests(_) => self.requests.due(at),
            What::Latest => self.latest.due(at),
            What::Machines(range) => self.machines(*range).due(at),
            What::Agents => self.agents.due(at),
            What::Doctor => self.doctor.due(at),
            What::Settings => self.settings.due(at),
            What::Keys => self.keys.due(at),
            What::Tailnet => self.tailnet.due(at),
        }
    }

    /// Takes a request the daemon just answered into the feed and the
    /// overview's latest, at the top, where their queries would list it;
    /// its cost comes with the next fetch. Everything drawn from the ledger
    /// is stale from now. True when the feed took it.
    pub fn record(&mut self, record: &LedgerRecord) -> bool {
        for slot in &mut self.history {
            slot.stale = true;
        }
        for slot in &mut self.machines {
            slot.stale = true;
        }
        for slot in self.pools.values_mut() {
            slot.stale = true;
        }
        self.requests.stale = true;
        self.latest.stale = true;
        if let Some(page) = &mut self.latest.value {
            take(page, record, LATEST);
        }
        if !lists(&self.query, record) {
            return false;
        }
        let Some(page) = &mut self.requests.value else {
            return false;
        };
        take(page, record, self.query.limit);
        true
    }
}

/// Whether a page of `query` lists a request just answered.
fn lists(query: &RequestQuery, record: &LedgerRecord) -> bool {
    let LedgerRecord::Request(request) = record;
    let failed = request.status >= 400;
    let outcome = match query.outcome {
        RequestOutcome::All => true,
        RequestOutcome::Answered => !failed,
        RequestOutcome::Failed => failed,
        RequestOutcome::Rescued => !failed && request.attempts > 1,
    };
    outcome
        && query
            .account
            .as_deref()
            .is_none_or(|a| request.account.as_deref() == Some(a))
        && query
            .model
            .as_deref()
            .is_none_or(|m| request.model.as_deref() == Some(m))
}

/// Puts a request just answered at the top of a page and counts it.
fn take(page: &mut RequestPage, record: &LedgerRecord, limit: u64) {
    let LedgerRecord::Request(request) = record;
    page.rows.insert(
        0,
        RequestRow {
            record: record.clone(),
            cost: None,
            end: None,
        },
    );
    page.rows.truncate(limit.max(1) as usize);
    page.matched += 1;
    page.tokens += request.usage.tokens();
    if request.status >= 400 {
        page.failed += 1;
    } else if request.attempts > 1 {
        page.rescued += 1;
    }
}

/// An answer the daemon is asked for.
#[derive(Debug, Clone, PartialEq)]
pub enum What {
    History(HistoryRange),
    Pool(Provider),
    Requests(RequestQuery),
    /// The overview's latest requests, by [`latest_query`].
    Latest,
    Machines(HistoryRange),
    Agents,
    Doctor,
    Settings,
    Keys,
    Tailnet,
}

/// An answer the daemon gave.
#[derive(Debug, Clone)]
pub enum Fetched {
    History(HistoryRange, Result<History, String>),
    Pool(Provider, Result<PoolDetail, String>),
    Requests(RequestQuery, Result<RequestPage, String>),
    Latest(Result<RequestPage, String>),
    Machines(HistoryRange, Result<Summary, String>),
    Agents(Result<Vec<AgentWiring>, String>),
    Doctor(Result<Vec<Section>, String>),
    Settings(Result<SettingsView, String>),
    Keys(Result<Vec<KeyInfo>, String>),
    Tailnet(Result<TailnetView, String>),
}

/// A change asked of the daemon.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Enable(String),
    Disable(String),
    Pin(String),
    UnpinAll,
    Check(String),
    Redeem(String),
    Connect(AgentId),
    Disconnect(AgentId),
    Settings(LivePatch),
    MakeKey(String),
    RemoveKey(String),
    Refresh,
}

/// What a change came back with.
#[derive(Debug, Clone)]
pub enum Outcome {
    Report(Box<Report>, String),
    Settings(Box<SettingsView>, String),
    Keys(Vec<KeyInfo>, String),
    NewKey(NewKey),
    Agent(String),
}

#[derive(Debug, Clone)]
pub enum Msg {
    Link(Link),
    Event(Box<Event>),
    Fetched(Box<Fetched>),
    Done(Action, Result<Outcome, String>),
}

/// Fetches `what` and sends the answer back as a message.
pub fn fetch(client: &Client, what: What, tx: &UnboundedSender<Msg>) {
    let (client, tx) = (client.clone(), tx.clone());
    let err = |e: slopmax_client::Error| e.to_string();
    tokio::spawn(async move {
        let fetched = match what {
            What::History(range) => {
                Fetched::History(range, client.history(range).await.map_err(err))
            }
            What::Pool(provider) => {
                Fetched::Pool(provider, client.pool(provider).await.map_err(err))
            }
            What::Requests(query) => {
                let answer = client.requests(&query).await.map_err(err);
                Fetched::Requests(query, answer)
            }
            What::Latest => Fetched::Latest(client.requests(&latest_query()).await.map_err(err)),
            What::Machines(range) => {
                let span = match range {
                    HistoryRange::Today => SummaryRange::Today,
                    HistoryRange::Week => SummaryRange::Week,
                    HistoryRange::Month => SummaryRange::Month,
                };
                let answer = client.usage(span, SummaryBy::Machine).await.map_err(err);
                Fetched::Machines(range, answer)
            }
            What::Agents => Fetched::Agents(client.agents().await.map_err(err)),
            What::Doctor => Fetched::Doctor(client.doctor().await.map_err(err)),
            What::Settings => Fetched::Settings(client.settings().await.map_err(err)),
            What::Keys => Fetched::Keys(client.keys().await.map_err(err)),
            What::Tailnet => Fetched::Tailnet(client.tailnet().await.map_err(err)),
        };
        let _ = tx.send(Msg::Fetched(Box::new(fetched)));
    });
}

/// Asks the daemon for `action` and sends back how it went.
pub fn act(client: &Client, action: Action, tx: &UnboundedSender<Msg>) {
    let (client, tx) = (client.clone(), tx.clone());
    tokio::spawn(async move {
        let report = |r: Report, said: &str| Outcome::Report(Box::new(r), said.to_owned());
        let name = |id: &str, r: &Report| {
            r.accounts
                .iter()
                .find(|a| a.id == id)
                .map_or(id.to_owned(), |a| a.name.clone())
        };
        let result = match &action {
            Action::Enable(id) | Action::Disable(id) => {
                let off = matches!(action, Action::Disable(_));
                let patch = AccountPatch {
                    disabled: Some(off),
                    ..Default::default()
                };
                client.update_account(id, &patch).await.map(|r| {
                    let said = if off {
                        format!("Turned {} off", name(id, &r))
                    } else {
                        format!("Turned {} on", name(id, &r))
                    };
                    report(r, &said)
                })
            }
            Action::Pin(id) => client.pin(id).await.map(|r| {
                let said = format!("New sessions go to {} first", name(id, &r));
                report(r, &said)
            }),
            Action::UnpinAll => client
                .unpin_all()
                .await
                .map(|r| report(r, "slopmax chooses the account again")),
            Action::Check(id) => client.check(id).await.map(|r| {
                let said = format!("Checked {}", name(id, &r));
                report(r, &said)
            }),
            Action::Redeem(id) => {
                client
                    .redeem(id, &RedeemRequest::default())
                    .await
                    .map(|answer| {
                        let who = name(id, &answer.report);
                        let said = match answer.outcome {
                            RedeemOutcome::Reset => format!("Reset {who}'s usage windows"),
                            RedeemOutcome::NothingToReset => {
                                format!("{who} has nothing to reset yet")
                            }
                            RedeemOutcome::NoCredit => format!("{who} holds no limit reset"),
                            RedeemOutcome::AlreadyRedeemed => {
                                "That limit reset was already spent".into()
                            }
                            RedeemOutcome::Declined => {
                                "The provider declined the limit reset".into()
                            }
                        };
                        report(answer.report, &said)
                    })
            }
            Action::Connect(agent) => client
                .connect_agent(*agent)
                .await
                .map(|c| Outcome::Agent(format!("Wrote {}. {}", c.path, c.note))),
            Action::Disconnect(agent) => client
                .disconnect_agent(*agent)
                .await
                .map(|d| Outcome::Agent(format!("Restored {}", d.path))),
            Action::Settings(patch) => client
                .change_settings(patch)
                .await
                .map(|view| Outcome::Settings(Box::new(view), "Applied now".into())),
            Action::MakeKey(key) => client
                .make_key(&MakeKey {
                    name: key.clone(),
                    models: Vec::new(),
                })
                .await
                .map(Outcome::NewKey),
            Action::RemoveKey(key) => client
                .remove_key(key)
                .await
                .map(|keys| Outcome::Keys(keys, format!("Revoked the key {key:?}"))),
            Action::Refresh => client
                .refresh()
                .await
                .map(|r| report(r, "Read every account's usage again")),
        };
        let _ = tx.send(Msg::Done(action, result.map_err(|e| e.to_string())));
    });
}

/// Follows the event stream for as long as the screen is open, connecting
/// again (after 1, 2, 4… up to 10 seconds) when it ends or breaks.
pub async fn follow(client: Client, tx: UnboundedSender<Msg>) {
    let mut wait = Duration::from_secs(1);
    loop {
        match client.events().await {
            Ok(mut events) => {
                wait = Duration::from_secs(1);
                let lost = loop {
                    match events.next().await {
                        Some(Ok(event)) => {
                            if let Event::Hello { version } = &event {
                                let _ = tx.send(Msg::Link(Link::Live(version.clone())));
                            }
                            if tx.send(Msg::Event(Box::new(event))).is_err() {
                                return;
                            }
                        }
                        Some(Err(e)) => break e.to_string(),
                        None => break "slopmax stopped".to_owned(),
                    }
                };
                if tx.send(Msg::Link(Link::Lost(lost))).is_err() {
                    return;
                }
            }
            Err(e) => {
                if tx.send(Msg::Link(Link::Lost(e.to_string()))).is_err() {
                    return;
                }
            }
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(10));
    }
}
