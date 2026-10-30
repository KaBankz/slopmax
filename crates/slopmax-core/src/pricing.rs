//! API list prices, for estimating what subscription usage would have cost
//! on the pay-as-you-go API. Estimates only: cache writes are priced at the
//! 5-minute rate, and models without a known price are left unpriced.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::provider::ProviderId;

/// Prices in US dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// A price set under `[prices]` in config.toml. Cache prices default to
/// the usual ratios: reads at a tenth of input, writes at 1.25×.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Custom {
    pub input: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

impl From<Custom> for Price {
    fn from(c: Custom) -> Self {
        Self {
            input: c.input,
            output: c.output,
            cache_read: c.cache_read.unwrap_or(c.input * 0.1),
            cache_write: c.cache_write.unwrap_or(c.input * 1.25),
        }
    }
}

/// Anthropic first-party API list prices as of 2026-09-25, by model id
/// prefix (dated ids such as `claude-haiku-4-5-20251001` match too). Cache
/// writes are 1.25× input; cache reads vary by model.
const CLAUDE: &[(&str, f64, f64, f64)] = &[
    // (model, input, output, cache read)
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-mythos-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-mythos-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4-8", 5.0, 25.0, 0.50),
    ("claude-opus-4-7", 5.0, 25.0, 0.50),
    ("claude-opus-4-6", 5.0, 25.0, 0.50),
    ("claude-sonnet-5-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-4-6", 3.0, 15.0, 0.30),
    ("claude-haiku-4-5", 1.0, 5.0, 0.10),
];

/// OpenAI API list prices as of 2026-09-22, when GPT-6's were halved.
/// Cached input is a tenth of input, and caching costs nothing extra.
const OPENAI: &[(&str, f64, f64, f64)] = &[
    // (model, input, output, cache read)
    ("gpt-6-sol", 2.0, 10.0, 0.20),
    ("gpt-6-luna", 0.10, 0.50, 0.01),
];

/// Subscription list prices in US dollars a month, by provider and the
/// plan its accounts report. What a plan costs varies by country and with
/// tax; `[plan_prices]` in config.toml sets the real figure.
const PLANS: &[(ProviderId, &str, f64)] = &[
    (ProviderId::Claude, "pro", 20.0),
    (ProviderId::Claude, "max", 100.0),
    (ProviderId::Claude, "max 5x", 100.0),
    (ProviderId::Claude, "max 20x", 200.0),
    (ProviderId::Claude, "team", 30.0),
    (ProviderId::Codex, "plus", 20.0),
    (ProviderId::Codex, "pro", 200.0),
    (ProviderId::Codex, "team", 30.0),
    (ProviderId::Codex, "business", 30.0),
];

/// What a subscription plan costs a month: the user's own figure, set as
/// `"claude/max 20x" = 200` under `[plan_prices]`, else the list price.
pub fn plan_monthly(
    provider: ProviderId,
    plan: &str,
    custom: &BTreeMap<String, f64>,
) -> Option<f64> {
    let plan = plan.trim().to_ascii_lowercase();
    let key = format!("{}/{plan}", provider.as_str());
    custom.get(&key).copied().or_else(|| {
        PLANS
            .iter()
            .find(|(p, name, _)| *p == provider && *name == plan)
            .map(|(.., price)| *price)
    })
}

/// The price of `model`: the user's own if they set one, else the list
/// price.
pub fn price(model: &str, custom: &BTreeMap<String, Custom>) -> Option<Price> {
    // Claude Code may tag a model with its context window, e.g. `[1m]`.
    let model = model.split('[').next().unwrap_or(model);
    if let Some((_, price)) = custom.iter().find(|(id, _)| is_model(model, id)) {
        return Some((*price).into());
    }
    let claude = CLAUDE.iter().map(|row| (row, 1.25));
    let openai = OPENAI.iter().map(|row| (row, 1.0));
    claude
        .chain(openai)
        .find(|((id, ..), _)| is_model(model, id))
        .map(|(&(_, input, output, cache_read), write)| Price {
            input,
            output,
            cache_read,
            cache_write: input * write,
        })
}

/// Whether `model` is `id` or a dated snapshot of it, such as
/// `claude-haiku-4-5-20251001`. Any other suffix is a different model.
fn is_model(model: &str, id: &str) -> bool {
    model.strip_prefix(id).is_some_and(|rest| {
        rest.is_empty()
            || rest
                .strip_prefix('-')
                .is_some_and(|date| date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()))
    })
}

impl Price {
    /// The cost in dollars of these token counts.
    pub fn cost(&self, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
        (input as f64 * self.input
            + output as f64 * self.output
            + cache_read as f64 * self.cache_read
            + cache_write as f64 * self.cache_write)
            / 1_000_000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(model: &str) -> Option<Price> {
        price(model, &BTreeMap::new())
    }

    #[test]
    fn matches_a_model_or_its_dated_snapshots() {
        assert_eq!(list("claude-opus-5-5").unwrap().input, 4.0);
        assert_eq!(list("claude-opus-5").unwrap().input, 5.0);
        assert_eq!(list("claude-fable-5-1").unwrap().cache_read, 0.25);
        assert_eq!(list("claude-fable-5").unwrap().cache_read, 1.0);
        assert_eq!(list("claude-haiku-4-5-20251001").unwrap().output, 5.0);
        assert_eq!(list("claude-opus-5-5[1m]").unwrap().input, 4.0);
        // An unknown version is not priced as its predecessor.
        assert!(list("claude-opus-5-6").is_none());
        assert!(list("claude-opus-5-5-fast").is_none());
        assert!(list("gpt-6-sol-pro").is_none());
    }

    #[test]
    fn plans_are_priced_by_provider_and_can_be_set() {
        let none = BTreeMap::new();
        assert_eq!(
            plan_monthly(ProviderId::Claude, "max 20x", &none),
            Some(200.0)
        );
        // "pro" is a different plan on each service.
        assert_eq!(plan_monthly(ProviderId::Claude, "Pro", &none), Some(20.0));
        assert_eq!(plan_monthly(ProviderId::Codex, "pro", &none), Some(200.0));
        assert_eq!(plan_monthly(ProviderId::Codex, "enterprise", &none), None);
        let mine = BTreeMap::from([("codex/pro".to_owned(), 229.0)]);
        assert_eq!(plan_monthly(ProviderId::Codex, "pro", &mine), Some(229.0));
    }

    #[test]
    fn openai_prices_charge_nothing_extra_to_cache() {
        let sol = list("gpt-6-sol").unwrap();
        assert_eq!(
            (sol.input, sol.output, sol.cache_read, sol.cache_write),
            (2.0, 10.0, 0.20, 2.0)
        );
        assert_eq!(list("gpt-6-luna").unwrap().output, 0.50);
    }

    #[test]
    fn custom_prices_win_and_fill_in_cache_rates() {
        let custom = BTreeMap::from([
            (
                "gpt-6-sol".to_owned(),
                Custom {
                    input: 2.0,
                    output: 16.0,
                    cache_read: None,
                    cache_write: None,
                },
            ),
            (
                "claude-opus-5-5".to_owned(),
                Custom {
                    input: 1.0,
                    output: 2.0,
                    cache_read: Some(0.5),
                    cache_write: Some(0.0),
                },
            ),
        ]);
        let gpt = price("gpt-6-sol", &custom).unwrap();
        assert_eq!((gpt.cache_read, gpt.cache_write), (0.2, 2.5));
        let opus = price("claude-opus-5-5", &custom).unwrap();
        assert_eq!(
            (opus.input, opus.cache_read, opus.cache_write),
            (1.0, 0.5, 0.0)
        );
    }

    #[test]
    fn costs_every_kind_of_token() {
        let p = list("claude-sonnet-5-5").unwrap();
        // 1M of each: 2 + 10 + 0.20 + 2.50.
        let cost = p.cost(1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert!((cost - 14.70).abs() < 1e-9, "{cost}");
    }
}
