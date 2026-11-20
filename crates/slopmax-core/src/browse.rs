//! The ledger's requests one by one, for the dashboard's Requests page and
//! its export: over a range, filtered by account, model, agent and how they
//! went, newest first, a page at a time, with the totals of everything that
//! matched and what the range can be filtered by. An agent's housekeeping
//! (listing models, counting tokens) is no request here, as in every count.
//!
//! The daemon counts the totals from the hours its index keeps ([`Tally`])
//! and reads only the hours a page's rows are in ([`rows`]), so a page
//! costs about the same over a month as over an hour. [`page`] reads every
//! request in the range instead, for when no index is kept.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use slopmax_api::ledger::{
    LedgerRecord, RequestEnd, RequestFacets, RequestOutcome, RequestPage, RequestRow, Sender,
};

use crate::ledger::{End, Entry};
use crate::pricing::{self, Custom};
use crate::time::Timestamp;

/// The most rows one page holds.
pub const MOST: usize = 1_000;

/// What to list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Query {
    pub account: Option<String>,
    pub model: Option<String>,
    pub agent: Option<Sender>,
    pub outcome: RequestOutcome,
    pub offset: usize,
    pub limit: usize,
}

fn rescued(entry: &Entry) -> bool {
    !entry.failed() && entry.attempts > 1
}

impl Query {
    /// Whether it takes requests to `account`, of `model`, from `agent`,
    /// however they went.
    pub(crate) fn takes_one(
        &self,
        account: &str,
        model: Option<&str>,
        agent: Option<Sender>,
    ) -> bool {
        self.account.as_ref().is_none_or(|a| a == account)
            && self.model.as_deref().is_none_or(|m| Some(m) == model)
            && self.agent.is_none_or(|a| Some(a) == agent)
    }

    fn takes(&self, entry: &Entry, agent: Option<Sender>) -> bool {
        self.takes_one(&entry.account, entry.model.as_deref(), agent)
            && match self.outcome {
                RequestOutcome::All => true,
                RequestOutcome::Answered => !entry.failed(),
                RequestOutcome::Failed => entry.failed(),
                RequestOutcome::Rescued => rescued(entry),
            }
    }
}

fn end(entry: &Entry) -> Option<RequestEnd> {
    match entry.end? {
        End::UpstreamError => Some(RequestEnd::UpstreamError),
        End::ClientGone => Some(RequestEnd::ClientGone),
        End::Stalled => Some(RequestEnd::Stalled),
        End::Cut => Some(RequestEnd::Cut),
        End::Complete | End::Other => None,
    }
}

/// What `entry` is worth at API prices, when its model has a known price.
pub fn cost(entry: &Entry, prices: &BTreeMap<String, Custom>) -> Option<f64> {
    let price = pricing::price(entry.model.as_deref()?, prices)?;
    Some(price.cost(
        entry.input,
        entry.output,
        entry.cache_read,
        entry.cache_write,
    ))
}

/// What every request a query takes came to, counted from the index's
/// hours.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tally {
    pub matched: u64,
    pub failed: u64,
    pub rescued: u64,
    /// What the answers among them moved, and cost.
    pub tokens: u64,
    pub cost: f64,
    pub facets: RequestFacets,
    /// Each local hour that holds some, newest first.
    pub hours: Vec<Hour>,
}

/// A local hour's requests that a query takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hour {
    /// Counted from the epoch on this machine's clock.
    pub hour: i64,
    pub matched: u64,
    /// When the hour's first request arrived and its last one ended, the
    /// query's or not: the stretch of the ledger its lines are in.
    pub first: Timestamp,
    pub settled: Timestamp,
}

/// The requests on `query`'s page, newest first, read from the ledger in
/// `dir`: only the stretch the hours they are in were written in, which
/// `tally` names, within the `lengths` marked as `tally` was counted.
pub fn rows(dir: &Path, query: &Query, tally: &Tally, lengths: &[(PathBuf, u64)]) -> Vec<Entry> {
    let limit = query.limit.clamp(1, MOST);
    let (offset, end) = (query.offset as u64, (query.offset + limit) as u64);
    // The hours the page's rows are in, and how many of the first hour's
    // matches come before the page.
    let (mut seen, mut skip) = (0, 0);
    let mut wanted: Vec<&Hour> = Vec::new();
    for hour in &tally.hours {
        if seen >= end {
            break;
        }
        if seen + hour.matched > offset {
            if wanted.is_empty() {
                skip = offset - seen;
            }
            wanted.push(hour);
        }
        seen += hour.matched;
    }
    let (Some(newest), Some(oldest)) = (wanted.first(), wanted.last()) else {
        return Vec::new();
    };
    let hours = oldest.hour..=newest.hour;
    let settled = wanted
        .iter()
        .map(|h| h.settled)
        .max()
        .unwrap_or(newest.settled);
    let mut found = Vec::new();
    crate::ledger::between(dir, oldest.first, settled, lengths, |entry| {
        if (entry.answered() || entry.failed())
            && hours.contains(&crate::history::index::hour_of(entry.at))
            && query.takes(&entry, entry.agent.as_deref().and_then(crate::api::sender))
        {
            found.push(entry);
        }
    });
    // Newest first; of two at once, the one written last.
    found.reverse();
    found.sort_by_key(|e| std::cmp::Reverse(e.at));
    found.into_iter().skip(skip as usize).take(limit).collect()
}

/// The page of `rows` (newest first, as [`rows`] reads them) with the
/// totals `tally` counted.
pub fn tallied(
    tally: Tally,
    rows: &[Entry],
    query: &Query,
    range: slopmax_api::ledger::HistoryRange,
    since: Timestamp,
    prices: &BTreeMap<String, Custom>,
) -> RequestPage {
    RequestPage {
        range,
        since,
        rows: rows.iter().map(|entry| row(entry, prices)).collect(),
        offset: query.offset as u64,
        matched: tally.matched,
        failed: tally.failed,
        rescued: tally.rescued,
        tokens: tally.tokens,
        cost: tally.cost,
        facets: tally.facets,
    }
}

fn row(entry: &Entry, prices: &BTreeMap<String, Custom>) -> RequestRow {
    RequestRow {
        record: LedgerRecord::Request(crate::api::record(entry)),
        cost: cost(entry, prices),
        end: end(entry),
    }
}

/// A page of `entries` (oldest first, as the ledger reads them) that
/// `query` takes, newest first.
pub fn page(
    entries: &[Entry],
    query: &Query,
    range: slopmax_api::ledger::HistoryRange,
    since: Timestamp,
    prices: &BTreeMap<String, Custom>,
) -> RequestPage {
    let limit = query.limit.clamp(1, MOST);
    let mut accounts = BTreeSet::new();
    let mut models = BTreeSet::new();
    let mut agents = BTreeSet::new();
    let mut page = RequestPage {
        range,
        since,
        rows: Vec::new(),
        offset: query.offset as u64,
        matched: 0,
        failed: 0,
        rescued: 0,
        tokens: 0,
        cost: 0.0,
        facets: RequestFacets::default(),
    };
    for entry in entries.iter().rev() {
        if !entry.answered() && !entry.failed() {
            continue;
        }
        let agent = entry.agent.as_deref().and_then(crate::api::sender);
        if !entry.account.is_empty() {
            accounts.insert(entry.account.as_str());
        }
        if let Some(model) = &entry.model {
            models.insert(model.as_str());
        }
        if let Some(agent) = agent {
            agents.insert(agent as u8);
        }
        if !query.takes(entry, agent) {
            continue;
        }
        let worth = cost(entry, prices);
        let at = page.matched as usize;
        page.matched += 1;
        page.failed += u64::from(entry.failed());
        page.rescued += u64::from(rescued(entry));
        if !entry.failed() {
            page.tokens += entry.tokens();
            page.cost += worth.unwrap_or(0.0);
        }
        if at >= query.offset && page.rows.len() < limit {
            page.rows.push(row(entry, prices));
        }
    }
    page.facets = RequestFacets {
        accounts: accounts.into_iter().map(str::to_owned).collect(),
        models: models.into_iter().map(str::to_owned).collect(),
        agents: Sender::ALL
            .into_iter()
            .filter(|a| agents.contains(&(*a as u8)))
            .collect(),
    };
    page
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderId;
    use slopmax_api::ledger::HistoryRange;

    fn entry(minute: i64, account: &str, model: &str, status: u16, attempts: u32) -> Entry {
        Entry {
            at: Timestamp::UNIX_EPOCH + crate::time::SignedDuration::from_mins(minute),
            account: account.into(),
            provider: ProviderId::Claude,
            model: Some(model.into()),
            status,
            input: 100,
            output: 50,
            cache_read: 0,
            cache_write: 0,
            ms: 1000,
            first_byte_ms: Some(200),
            attempts,
            agent: Some("claude".into()),
            session: None,
            machine: None,
            end: None,
        }
    }

    fn list(entries: &[Entry], query: &Query) -> RequestPage {
        page(
            entries,
            query,
            HistoryRange::Today,
            Timestamp::UNIX_EPOCH,
            &BTreeMap::new(),
        )
    }

    #[test]
    fn lists_newest_first_a_page_at_a_time_with_every_match_counted() {
        let entries: Vec<Entry> = (0..10)
            .map(|m| entry(m, "a", "claude-opus-5-5", 200, 1))
            .collect();
        let query = Query {
            offset: 2,
            limit: 3,
            ..Query::default()
        };
        let page = list(&entries, &query);
        let minutes: Vec<i64> = page
            .rows
            .iter()
            .map(|r| {
                let LedgerRecord::Request(record) = &r.record;
                record.at.as_second() / 60
            })
            .collect();
        assert_eq!(minutes, [7, 6, 5]);
        assert_eq!(page.matched, 10);
        assert_eq!(page.tokens, 1500);
        assert!(page.cost > 0.0);
        assert!(page.rows[0].cost.is_some());
    }

    #[test]
    fn filters_by_account_model_and_outcome_but_offers_every_choice() {
        let entries = vec![
            entry(0, "a", "claude-opus-5-5", 200, 1),
            entry(1, "b", "claude-opus-5-5", 529, 2),
            entry(2, "b", "claude-sonnet-5", 200, 2),
            entry(3, "a", "claude-sonnet-5", 200, 1),
        ];
        let only = |query: Query| list(&entries, &Query { limit: 50, ..query });
        assert_eq!(
            only(Query {
                account: Some("b".into()),
                ..Query::default()
            })
            .matched,
            2
        );
        let failed = only(Query {
            outcome: RequestOutcome::Failed,
            ..Query::default()
        });
        assert_eq!((failed.matched, failed.failed), (1, 1));
        let rescued = only(Query {
            outcome: RequestOutcome::Rescued,
            ..Query::default()
        });
        assert_eq!(rescued.matched, 1);
        let opus = only(Query {
            model: Some("claude-opus-5-5".into()),
            ..Query::default()
        });
        assert_eq!(opus.matched, 2);
        assert_eq!(opus.facets.accounts, ["a", "b"]);
        assert_eq!(opus.facets.models, ["claude-opus-5-5", "claude-sonnet-5"]);
        assert_eq!(opus.facets.agents, [Sender::ClaudeCode]);
    }

    #[test]
    fn leaves_out_an_agents_housekeeping() {
        // Claude Code listing models: no model, no tokens.
        let models = Entry {
            model: None,
            input: 0,
            output: 0,
            ..entry(1, "a", "", 200, 1)
        };
        // Counting tokens names a model but moves none.
        let count = Entry {
            input: 0,
            output: 0,
            ..entry(2, "a", "claude-haiku-5", 200, 1)
        };
        let entries = vec![entry(0, "a", "claude-opus-5-5", 200, 1), models, count];
        let page = list(
            &entries,
            &Query {
                limit: 50,
                ..Query::default()
            },
        );
        assert_eq!(page.matched, 1);
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.facets.models, ["claude-opus-5-5"]);
    }

    /// A ledger written as a daemon writes one: each request as it ends,
    /// some running half an hour, over 40 days, beside lines that are no
    /// request.
    fn written(dir: &Path, now: Timestamp) {
        let ledger = crate::ledger::Ledger::at(dir.to_path_buf());
        let mut seed = 7u64;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (seed >> 33) % n
        };
        let mut entries = Vec::new();
        let start = now - crate::time::SignedDuration::from_hours(24 * 40);
        let mut at = start;
        while at < now {
            at = at + crate::time::SignedDuration::from_secs(1 + next(1_400) as i64);
            let roll = next(100);
            let model = ["claude-opus-5-5", "claude-haiku-5-5", "gpt-6.1-sol"][next(3) as usize];
            let mut entry = Entry {
                ms: if roll < 3 {
                    1_800_000
                } else {
                    500 + next(90_000)
                },
                agent: ["claude", "codex", "slopmax", "pi"][next(4) as usize]
                    .to_owned()
                    .into(),
                input: if roll < 6 { 150_000 } else { next(5_000) },
                ..entry(0, ["a", "b", "c", ""][next(4) as usize], model, 200, 1)
            };
            entry.at = at;
            match roll {
                6..=9 => entry.status = 529,
                10 => entry.end = Some(End::Stalled),
                11..=16 => entry.attempts = 2,
                17 => (entry.model, entry.input, entry.output) = (None, 0, 0),
                18 => (entry.input, entry.output) = (0, 0),
                _ => {}
            }
            entries.push(entry);
        }
        entries.sort_by_key(|e| e.at + crate::time::SignedDuration::from_millis(e.ms as i64));
        for (i, entry) in entries.iter().enumerate() {
            ledger.record(entry);
            if i % 97 == 0 {
                let month = dir.join(crate::ledger::month_name(entry.at));
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(month)
                    .unwrap();
                std::io::Write::write_all(&mut file, b"{\"quota\":{\"x\":1}}\n").unwrap();
            }
        }
    }

    #[test]
    fn a_page_from_the_index_and_its_hours_is_the_page_every_line_gives() {
        let dir = std::env::temp_dir().join(format!("slopmax-browse-{}", crate::ids::token()));
        let now = Timestamp::now();
        written(&dir, now);
        let all = crate::ledger::read(&dir, Timestamp::UNIX_EPOCH);
        assert!(all.len() > 2_000);
        let index = crate::history::index::Index::of(&all);
        let lengths = crate::ledger::Ledger::at(dir.clone()).mark(&mut || {});
        let prices = BTreeMap::new();
        let queries = [
            Query::default(),
            Query {
                offset: 3,
                limit: 6,
                ..Query::default()
            },
            Query {
                offset: 250,
                limit: 100,
                ..Query::default()
            },
            Query {
                offset: 90_000,
                limit: 100,
                ..Query::default()
            },
            Query {
                account: Some("b".into()),
                limit: 1_000,
                ..Query::default()
            },
            Query {
                account: Some("".into()),
                limit: 50,
                ..Query::default()
            },
            Query {
                model: Some("claude-haiku-5-5".into()),
                offset: 40,
                limit: 70,
                ..Query::default()
            },
            Query {
                agent: Some(Sender::Codex),
                limit: 30,
                ..Query::default()
            },
            Query {
                outcome: RequestOutcome::Failed,
                limit: 40,
                ..Query::default()
            },
            Query {
                outcome: RequestOutcome::Failed,
                offset: 41,
                limit: 5,
                ..Query::default()
            },
            Query {
                outcome: RequestOutcome::Rescued,
                limit: 20,
                ..Query::default()
            },
            Query {
                outcome: RequestOutcome::Answered,
                account: Some("a".into()),
                limit: 100,
                ..Query::default()
            },
            Query {
                model: Some("nothing".into()),
                limit: 100,
                ..Query::default()
            },
        ];
        for range in [HistoryRange::Today, HistoryRange::Week, HistoryRange::Month] {
            let since = crate::summary::since(crate::api::history_range(range).key(), now).unwrap();
            let entries = crate::ledger::read(&dir, since);
            for query in &queries {
                let slow = page(&entries, query, range, since, &prices);
                let tally = index.requests(query, since, &prices);
                let fast = tallied(
                    tally.clone(),
                    &rows(&dir, query, &tally, &lengths),
                    query,
                    range,
                    since,
                    &prices,
                );
                let close = (fast.cost - slow.cost).abs() <= 1e-9 * slow.cost.max(1.);
                assert!(close, "{range:?} {query:?}: {} vs {}", fast.cost, slow.cost);
                assert_eq!(
                    RequestPage {
                        cost: slow.cost,
                        ..fast
                    },
                    slow,
                    "{range:?} {query:?}"
                );
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
