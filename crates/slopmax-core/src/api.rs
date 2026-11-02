//! The engine's state in the API's types ([`slopmax_api`]): the one place
//! that decides how an account, a pool or a request reads to a front end.

use slopmax_api as api;
use slopmax_api::report::{AccountView, Condition, LimitReset, Note, PoolView, PoolWindow};

use crate::config::{self, Config};
use crate::ledger::Entry;
use crate::limits::Window;
use crate::notify;
use crate::pool::Reason;
use crate::provider::ProviderId;
use crate::report::{self, AccountReport, PoolReport, Report};
use crate::time::Timestamp;
use crate::wire;

pub fn provider(id: ProviderId) -> api::Provider {
    match id {
        ProviderId::Claude => api::Provider::Claude,
        ProviderId::Codex => api::Provider::Codex,
        ProviderId::Anthropic => api::Provider::Anthropic,
        ProviderId::OpenAI => api::Provider::OpenAi,
        ProviderId::Xai => api::Provider::Xai,
        ProviderId::Compat => api::Provider::Compat,
    }
}

pub fn provider_id(provider: api::Provider) -> ProviderId {
    match provider {
        api::Provider::Claude => ProviderId::Claude,
        api::Provider::Codex => ProviderId::Codex,
        api::Provider::Anthropic => ProviderId::Anthropic,
        api::Provider::OpenAi => ProviderId::OpenAI,
        api::Provider::Xai => ProviderId::Xai,
        api::Provider::Compat => ProviderId::Compat,
    }
}

pub fn strategy(strategy: config::Strategy) -> api::Strategy {
    match strategy {
        config::Strategy::ResetFirst => api::Strategy::ResetFirst,
        config::Strategy::FillFirst => api::Strategy::FillFirst,
        config::Strategy::LeastUsed => api::Strategy::LeastUsed,
        config::Strategy::RoundRobin => api::Strategy::RoundRobin,
    }
}

pub fn config_strategy(strategy: api::Strategy) -> config::Strategy {
    match strategy {
        api::Strategy::ResetFirst => config::Strategy::ResetFirst,
        api::Strategy::FillFirst => config::Strategy::FillFirst,
        api::Strategy::LeastUsed => config::Strategy::LeastUsed,
        api::Strategy::RoundRobin => config::Strategy::RoundRobin,
    }
}

pub fn dialect(dialect: wire::Dialect) -> api::Dialect {
    match dialect {
        wire::Dialect::Messages => api::Dialect::Messages,
        wire::Dialect::Responses => api::Dialect::Responses,
        wire::Dialect::Chat => api::Dialect::Chat,
    }
}

pub fn wire_dialect(dialect: api::Dialect) -> wire::Dialect {
    match dialect {
        api::Dialect::Messages => wire::Dialect::Messages,
        api::Dialect::Responses => wire::Dialect::Responses,
        api::Dialect::Chat => wire::Dialect::Chat,
    }
}

/// `5h`, `7d` or `30d`; any other length reads as the nearest.
pub fn span(span: &str) -> api::Span {
    match span {
        "5h" => api::Span::FiveHours,
        "30d" => api::Span::Month,
        _ => api::Span::Week,
    }
}

fn window(w: &Window) -> api::report::Window {
    api::report::Window {
        span: span(&w.span),
        model: w.model.clone(),
        used: w.used.clamp(0.0, 100.0),
        resets_at: w.resets_at,
    }
}

pub fn usage(u: &wire::Usage) -> api::report::Usage {
    api::report::Usage {
        requests: u.requests,
        input: u.input_tokens,
        output: u.output_tokens,
        cache_read: u.cache_read_tokens,
        cache_write: u.cache_write_tokens,
    }
}

/// The status report as the API gives it: `report` with every decision a
/// front end shows made, and the nudges the accounts call for.
pub fn report(report: &Report, config: &Config, now: Timestamp) -> api::report::Report {
    let subjects: Vec<notify::Subject> = report.accounts.iter().map(notify::Subject::of).collect();
    let nudges = notify::nudges(
        &subjects,
        config.redeem_expiring_credits,
        &config.plan_prices,
        now,
    );
    api::report::Report {
        version: report.version.clone(),
        live: report.live,
        generated_at: report.generated_at,
        strategy: strategy(report.strategy),
        accounts: report.accounts.iter().map(|a| account(a, now)).collect(),
        pools: report.pools.iter().map(pool).collect(),
        nudges: nudges.iter().map(|(key, e)| notice(key, e)).collect(),
    }
}

pub fn account(a: &AccountReport, now: Timestamp) -> AccountView {
    let state = &a.state;
    let condition = match a.condition(now) {
        report::Condition::SignInNeeded(error) => Condition::SignInNeeded { error },
        report::Condition::Disabled => Condition::Disabled,
        report::Condition::Limited(until) => Condition::Limited { until },
        report::Condition::Throttled => Condition::Throttled {
            until: state.throttled_until,
        },
        report::Condition::Active(sessions) => Condition::Active {
            sessions: sessions as u64,
        },
        report::Condition::Ready => Condition::Ready,
    };
    let notes = a
        .notes(now)
        .into_iter()
        .map(|note| match note {
            report::Note::Pinned => Note::Pinned,
            report::Note::Priority(value) => Note::Priority { value },
            report::Note::Follows(tool) => Note::Follows { tool },
            report::Note::ResetCredits(count) => Note::Resets {
                count: count.into(),
            },
            report::Note::Served { requests, tokens } => Note::Served { requests, tokens },
            report::Note::LastError(text) => Note::LastError { text },
        })
        .collect();
    let mut resets: Vec<LimitReset> = state
        .unexpired_credits(now)
        .map(|c| LimitReset {
            id: c.id.clone(),
            title: c.title.clone(),
            granted_at: c.granted_at,
            expires_at: c.expires_at,
        })
        .collect();
    resets.sort_by_key(|r| r.expires_at.unwrap_or(Timestamp::MAX));
    AccountView {
        id: a.id.clone(),
        provider: provider(a.provider),
        name: a.name.clone(),
        email: a.email.clone(),
        plan: a.plan.clone(),
        disabled: a.disabled,
        priority: a.priority,
        pinned: a.pinned,
        follows: a.follows.clone(),
        token_expires_at: a.token_expires_at,
        endpoint: a.endpoint.clone(),
        models: a.models.clone(),
        sessions: a.sessions as u64,
        condition,
        notes,
        windows: state.limits.windows.iter().map(window).collect(),
        resets,
        last_used: state.last_used,
        served: usage(&state.usage),
    }
}

fn pool(p: &PoolReport) -> PoolView {
    let weighted = !p.shares.is_empty();
    PoolView {
        provider: provider(p.provider),
        accounts: p.accounts as u64,
        windows: p
            .windows
            .iter()
            .filter(|w| w.model.is_none())
            .map(|w| PoolWindow {
                span: span(&w.span),
                used: w.used,
                resets_at: w.resets_at,
                weighted,
            })
            .collect(),
        scoped: p.scoped_windows().map(window).collect(),
        shares: p.shares.clone(),
        next: p.next.as_ref().map(|n| api::report::NextView {
            account: n.account.clone(),
            reason: match n.reason {
                Reason::Pinned => api::report::NextReason::Pinned,
                Reason::OnlyReady => api::report::NextReason::OnlyOne,
                Reason::WeekEndsSoonest => api::report::NextReason::WeekEnding,
                Reason::ResetsSoonest => api::report::NextReason::ResetsFirst,
                Reason::FirstInOrder => api::report::NextReason::FillsFirst,
                Reason::MostRoom => api::report::NextReason::MostRoom,
                Reason::NextInTurn => api::report::NextReason::Turn,
            },
            why: n.why.clone(),
        }),
    }
}

pub fn notice_kind(kind: notify::Kind) -> api::NoticeKind {
    match kind {
        notify::Kind::Limited => api::NoticeKind::Limited,
        notify::Kind::Available => api::NoticeKind::Available,
        notify::Kind::Exhausted => api::NoticeKind::Exhausted,
        notify::Kind::Recovered => api::NoticeKind::Recovered,
        notify::Kind::SignedOut => api::NoticeKind::SignedOut,
        notify::Kind::ResetExpiring => api::NoticeKind::ResetExpiring,
        notify::Kind::QuotaUnused => api::NoticeKind::QuotaUnused,
        notify::Kind::Test => api::NoticeKind::Test,
    }
}

/// A notice, under the key that tells it once.
pub fn notice(key: &str, e: &notify::Event) -> api::report::Notice {
    api::report::Notice {
        kind: notice_kind(e.event),
        key: key.to_owned(),
        provider: e.provider.map(provider),
        account: e.account.clone(),
        until: e.until,
        message: e.message.clone(),
        at: e.at,
        worth: e.worth,
    }
}

/// A finished request, as the event stream tells it.
pub fn record(e: &Entry) -> api::ledger::RequestRecord {
    use api::ledger::{RequestRecord, Sender, Via};
    RequestRecord {
        at: e.at,
        account: (!e.account.is_empty()).then(|| e.account.clone()),
        provider: provider(e.provider),
        model: e.model.clone(),
        status: e.status,
        usage: api::report::Usage {
            requests: 1,
            input: e.input,
            output: e.output,
            cache_read: e.cache_read,
            cache_write: e.cache_write,
        },
        ms: e.ms,
        first_byte_ms: e.first_byte_ms,
        attempts: e.attempts,
        agent: e.agent.as_deref().and_then(|agent| match agent {
            "claude" | "claude-code" => Some(Sender::ClaudeCode),
            "codex" => Some(Sender::Codex),
            "slopmax" => Some(Sender::Slopmax),
            _ => None,
        }),
        session: e.session.clone(),
        via: Via::Http,
    }
}

fn totals(t: &crate::summary::Totals) -> api::ledger::Totals {
    api::ledger::Totals {
        requests: t.requests,
        input: t.input,
        output: t.output,
        cache_read: t.cache_read,
        cache_write: t.cache_write,
        cost: t.cost,
        unpriced: t.unpriced,
        failed: t.failed,
    }
}

/// A usage summary over `range`, grouped `by`.
pub fn summary(
    s: &crate::summary::Summary,
    range: api::ledger::SummaryRange,
    by: api::ledger::SummaryBy,
) -> api::ledger::Summary {
    api::ledger::Summary {
        range,
        by,
        since: s.since,
        rows: s
            .rows
            .iter()
            .map(|(key, t)| api::ledger::SummaryRow {
                key: key.clone(),
                totals: totals(t),
            })
            .collect(),
        total: totals(&s.total),
    }
}

pub fn history_range(range: api::ledger::HistoryRange) -> crate::history::Range {
    match range {
        api::ledger::HistoryRange::Today => crate::history::Range::Today,
        api::ledger::HistoryRange::Week => crate::history::Range::Week,
        api::ledger::HistoryRange::Month => crate::history::Range::Month,
    }
}

/// What went through slopmax over a range, as the dashboard charts it.
pub fn history(
    h: &crate::history::History,
    range: api::ledger::HistoryRange,
) -> api::ledger::History {
    use api::ledger::{
        AccountTotals, HistoryBucket, LeftAccount, LeftOnTheTable, NamedTotals, Speed,
    };
    api::ledger::History {
        range,
        buckets: h
            .buckets
            .iter()
            .map(|b| HistoryBucket {
                label: b.label.clone(),
                tokens: b.tokens.iter().map(|t| *t as f64).collect(),
                requests: b.requests,
                failed: b.failed,
                rescued: b.rescued,
                sessions: b.sessions,
                cost: b.cost,
                cached: b.cached.map(f64::from),
                first_byte: b.first_byte.map(|(a, b)| (a as f64, b as f64)),
            })
            .collect(),
        providers: h.providers.iter().copied().map(provider).collect(),
        total: totals(&h.total),
        rescued: h.rescued,
        unplaced: h.unplaced,
        billed: h.billed,
        left: LeftOnTheTable {
            windows: h.left.windows,
            unused: h.left.unused,
            dollars: h.left.dollars,
            unpriced: h.left.unpriced,
            accounts: h
                .left
                .accounts
                .iter()
                .map(|a| LeftAccount {
                    name: a.name.clone(),
                    provider: provider(a.provider),
                    windows: a.windows,
                    unused: a.unused,
                    dollars: a.dollars,
                })
                .collect(),
        },
        cache_saved: h.cache_saved,
        cached: h.cached.map(f64::from),
        sessions: h.sessions,
        first_byte: h.first_byte.map(|ms| ms as f64),
        monthly: h.monthly,
        activity: h.activity.iter().map(|day| day.to_vec()).collect(),
        models: h
            .models
            .iter()
            .map(|s| NamedTotals {
                name: s.name.clone(),
                totals: totals(&s.totals),
            })
            .collect(),
        accounts: h
            .accounts
            .iter()
            .map(|s| AccountTotals {
                name: s.name.clone(),
                provider: provider(s.provider),
                totals: totals(&s.totals),
            })
            .collect(),
        agents: h
            .agents
            .iter()
            .map(|p| NamedTotals {
                name: p.name.to_owned(),
                totals: totals(&p.totals),
            })
            .collect(),
        speeds: h
            .speeds
            .iter()
            .map(|s| Speed {
                model: s.model.clone(),
                provider: provider(s.provider),
                tokens_per_second: s.tokens_per_second,
            })
            .collect(),
    }
}

/// The settings as the API shows them.
pub fn settings(config: &Config) -> api::settings::PublicSettings {
    use api::settings::{LiveSettings, NotifySettings, Price, PublicSettings};
    PublicSettings {
        listen: config.listen.to_string(),
        upstream_proxy: config.proxy.clone(),
        live: LiveSettings {
            strategy: strategy(config.strategy),
            session_affinity: config.session_affinity,
            session_minutes: config.session_ttl_mins,
            redeem_expiring: config.redeem_expiring_credits,
            redeem_when_exhausted: config.redeem_when_exhausted,
            warm_windows: config.warm_windows,
            paid_overflow: config.paid_overflow,
            poll_minutes: config.poll_mins,
            refresh_tokens: config.refresh_tokens,
            websockets: config.websockets,
        },
        aliases: config.aliases.clone(),
        fallbacks: config.fallbacks.clone(),
        prices: config
            .prices
            .iter()
            .map(|(model, p)| {
                let price = Price {
                    input: p.input,
                    output: p.output,
                    cache_read: p.cache_read,
                    cache_write: p.cache_write,
                };
                (model.clone(), price)
            })
            .collect(),
        plan_prices: config.plan_prices.clone(),
        notify: NotifySettings {
            webhook: config.notify.webhook.clone(),
            command: config.notify.command.clone(),
            // None named means the defaults.
            events: match config.notify.events.as_slice() {
                [] => notify::DEFAULT_EVENTS,
                named => named,
            }
            .iter()
            .copied()
            .map(notice_kind)
            .collect(),
        },
        keys: config.keys.iter().map(key_info).collect(),
    }
}

pub fn key_info(key: &config::ClientKey) -> api::settings::KeyInfo {
    api::settings::KeyInfo {
        name: key.name.clone(),
        models: key.models.clone(),
    }
}

/// A live setting's value as `config.toml` holds it.
pub fn toml_value(value: api::settings::LiveValue) -> toml_edit::Value {
    match value {
        api::settings::LiveValue::Switch(on) => on.into(),
        api::settings::LiveValue::Minutes(minutes) => (minutes as i64).into(),
        api::settings::LiveValue::Strategy(s) => s.as_str().into(),
    }
}
