//! The ledger's requests one by one, for the dashboard's Requests page and
//! its export: over a range, filtered by account, model, agent and how they
//! went, newest first, a page at a time, with the totals of everything that
//! matched and what the range can be filtered by.

use std::collections::{BTreeMap, BTreeSet};

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
    fn takes(&self, entry: &Entry, agent: Option<Sender>) -> bool {
        self.account.as_ref().is_none_or(|a| *a == entry.account)
            && self
                .model
                .as_ref()
                .is_none_or(|m| Some(m) == entry.model.as_ref())
            && self.agent.is_none_or(|a| Some(a) == agent)
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

fn cost(entry: &Entry, prices: &BTreeMap<String, Custom>) -> Option<f64> {
    let price = pricing::price(entry.model.as_deref()?, prices)?;
    Some(price.cost(
        entry.input,
        entry.output,
        entry.cache_read,
        entry.cache_write,
    ))
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
        let record = crate::api::record(entry);
        if !entry.account.is_empty() {
            accounts.insert(entry.account.as_str());
        }
        if let Some(model) = &entry.model {
            models.insert(model.as_str());
        }
        if let Some(agent) = record.agent {
            agents.insert(agent as u8);
        }
        if !query.takes(entry, record.agent) {
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
            page.rows.push(RequestRow {
                record: LedgerRecord::Request(record),
                cost: worth,
                end: end(entry),
            });
        }
    }
    page.facets = RequestFacets {
        accounts: accounts.into_iter().map(str::to_owned).collect(),
        models: models.into_iter().map(str::to_owned).collect(),
        agents: [Sender::ClaudeCode, Sender::Codex, Sender::Slopmax]
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
}
