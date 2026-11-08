//! What went through slopmax, as the daemon's `/history` answers it: by
//! hour or day, by provider, model, account and agent.

pub use slopmax_api::ledger::{
    AccountTotals, History, HistoryBucket as Bucket, HistoryRange as Range, LeftAccount,
    LeftOnTheTable, NamedTotals, Speed, Totals,
};

/// Every range, shortest first.
pub const RANGES: [Range; 3] = [Range::Today, Range::Week, Range::Month];

/// Every token a request moved: input, output, and both kinds of cache.
pub fn tokens(totals: &Totals) -> u64 {
    totals.input + totals.output + totals.cache_read + totals.cache_write
}

/// The share of input read from cache, from 0 to 1, when any came in.
pub fn cached(totals: &Totals) -> Option<f32> {
    let input = totals.input + totals.cache_read + totals.cache_write;
    (input > 0).then(|| totals.cache_read as f32 / input as f32)
}
