//! API list prices, for estimating what subscription usage would have cost
//! on the pay-as-you-go API. Estimates only: cache writes are priced at the
//! 5-minute rate, and models without a known price are left unpriced. A
//! model priced by prompt length costs each request at the prices for its
//! own prompt.

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

/// A price set under `[prices]` in config.toml, which every prompt pays
/// whatever its length. Cache prices default to the usual ratios: reads at
/// a tenth of input, writes at 1.25×.
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

/// Anthropic first-party API list prices as of 2026-11-14, by model id
/// prefix (dated ids such as `claude-haiku-4-5-20251001` match too). Cache
/// writes are 1.25× input; cache reads vary by model. Haiku 5.5's are for
/// prompts up to 100,000 tokens; [`LONG`] has its prices for longer ones.
const CLAUDE: &[(&str, f64, f64, f64)] = &[
    // (model, input, output, cache read)
    ("claude-fable-5-2", 8.0, 40.0, 0.20),
    ("claude-mythos-5-2", 8.0, 40.0, 0.20),
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-mythos-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-mythos-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4-8", 5.0, 25.0, 0.50),
    ("claude-opus-4-7", 5.0, 25.0, 0.50),
    ("claude-opus-4-6", 5.0, 25.0, 0.50),
    ("claude-opus-4-5", 5.0, 25.0, 0.50),
    ("claude-sonnet-5-5", 2.0, 10.0, 0.10),
    ("claude-sonnet-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-4-6", 3.0, 15.0, 0.30),
    ("claude-sonnet-4-5", 3.0, 15.0, 0.30),
    ("claude-haiku-5-5", 0.10, 0.50, 0.01),
    ("claude-haiku-4-5", 1.0, 5.0, 0.10),
];

/// OpenAI API list prices as of 2026-11-14 (GPT-5.6 Sol's is a promotion
/// that ends 2026-11-30). Cached input is a tenth of input or less, and a
/// 30-minute cache write costs 1.25× input.
const OPENAI: &[(&str, f64, f64, f64)] = &[
    // (model, input, output, cache read)
    ("gpt-6-astra", 10.0, 50.0, 1.0),
    ("gpt-6.1-sol", 2.0, 10.0, 0.10),
    ("gpt-6.1-terra", 1.0, 5.0, 0.05),
    ("gpt-6-sol", 2.0, 10.0, 0.20),
    ("gpt-6-luna", 0.10, 0.50, 0.01),
    ("gpt-5.6-sol", 4.0, 20.0, 0.40),
    ("gpt-5.6-terra", 2.0, 12.0, 0.20),
    ("gpt-5.6-luna", 0.20, 1.20, 0.02),
];

/// The models priced by prompt length, as of 2026-11-15: a request whose
/// prompt is over `over` tokens pays these prices on all of its tokens,
/// output included. A prompt counts all of the request's input tokens,
/// cache reads and cache writes among them, and cache writes cost 1.25×
/// input here too. Of Claude's models only Haiku 5.5 is; the rest are
/// priced the same up to their full context window. OpenAI's cost twice
/// as much input and half as much again output past 272K input tokens,
/// which count cached input and cache writes, as OpenAI counts an input
/// token as one of input, cached input or cache write.
const LONG: &[(&str, u64, f64, f64, f64)] = &[
    // (model, over, input, output, cache read)
    ("claude-haiku-5-5", 100_000, 0.50, 2.50, 0.05),
    ("gpt-6-astra", 272_000, 20.0, 75.0, 2.0),
    ("gpt-6.1-sol", 272_000, 4.0, 15.0, 0.20),
    ("gpt-6.1-terra", 272_000, 2.0, 7.5, 0.10),
    ("gpt-6-sol", 272_000, 4.0, 15.0, 0.40),
    ("gpt-6-luna", 272_000, 0.20, 0.75, 0.02),
    ("gpt-5.6-sol", 272_000, 8.0, 30.0, 0.80),
    ("gpt-5.6-terra", 272_000, 4.0, 18.0, 0.40),
    ("gpt-5.6-luna", 272_000, 0.40, 1.80, 0.04),
];

/// Subscription list prices in US dollars a month, by provider and the
/// plan its accounts report. What a plan costs varies by country and with
/// tax; `[plan_prices]` in config.toml sets the real figure.
const PLANS: &[(ProviderId, &str, f64)] = &[
    (ProviderId::Claude, "pro", 20.0),
    (ProviderId::Claude, "max", 100.0),
    (ProviderId::Claude, "ultra", 200.0),
    // Their names before 2026-10-30, which older accounts still carry.
    (ProviderId::Claude, "max 5x", 100.0),
    (ProviderId::Claude, "max 20x", 200.0),
    (ProviderId::Claude, "team", 30.0),
    (ProviderId::Codex, "plus", 20.0),
    (ProviderId::Codex, "pro", 200.0),
    (ProviderId::Codex, "team", 30.0),
    (ProviderId::Codex, "business", 30.0),
];

/// What a subscription plan costs a month: the user's own figure, set as
/// `"claude/ultra" = 200` under `[plan_prices]`, else the list price.
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

/// How much usage each plan allows, against the smallest of its provider:
/// Claude's Max and Ultra are sold as 5 and 10 times Pro's weekly usage
/// (Ultra was Max 20x, named for its 5-hour limit, which it no longer has).
/// ChatGPT states no such ratio, so its plans have none here.
const CAPACITY: &[(ProviderId, &str, f64)] = &[
    (ProviderId::Claude, "pro", 1.0),
    (ProviderId::Claude, "max", 5.0),
    (ProviderId::Claude, "max 5x", 5.0),
    (ProviderId::Claude, "ultra", 10.0),
    (ProviderId::Claude, "max 20x", 10.0),
];

/// Each account's share of its pool's capacity, by plan, in the order
/// given; `None` unless every plan's size is known, as a mean weighted by
/// guesses would mislead more than a plain one.
pub fn shares(provider: ProviderId, plans: &[Option<&str>]) -> Option<Vec<f64>> {
    let sizes: Vec<f64> = plans
        .iter()
        .map(|plan| {
            let plan = (*plan)?.trim().to_ascii_lowercase();
            CAPACITY
                .iter()
                .find(|(p, name, _)| *p == provider && *name == plan)
                .map(|(.., size)| *size)
        })
        .collect::<Option<_>>()?;
    let total: f64 = sizes.iter().sum();
    (total > 0.0).then(|| sizes.iter().map(|s| s / total).collect())
}

/// The price of `model`: the user's own if they set one, else the list
/// price.
pub fn price(model: &str, custom: &BTreeMap<String, Custom>) -> Option<Pricing> {
    let model = untagged(model);
    if let Some((_, price)) = custom.iter().find(|(id, _)| is_model(model, id)) {
        return Some(Pricing {
            base: (*price).into(),
            long: None,
        });
    }
    let base = CLAUDE
        .iter()
        .chain(OPENAI)
        .find(|(id, ..)| is_model(model, id))
        .map(|&(_, input, output, cache_read)| listed(input, output, cache_read))?;
    let long = LONG.iter().find(|(id, ..)| is_model(model, id)).map(
        |&(_, over, input, output, cache_read)| Long {
            over,
            price: listed(input, output, cache_read),
        },
    );
    Some(Pricing { base, long })
}

/// A list price, whose cache writes cost 1.25× input.
fn listed(input: f64, output: f64, cache_read: f64) -> Price {
    Price {
        input,
        output,
        cache_read,
        cache_write: input * 1.25,
    }
}

/// Whether a request to `model` with a prompt of `prompt` tokens pays the
/// list's prices for a long prompt. A price the user set is the same at any
/// length, so [`Pricing::tier`] gives it either way.
pub fn is_long(model: &str, prompt: u64) -> bool {
    LONG.iter()
        .any(|(id, over, ..)| prompt > *over && is_model(untagged(model), id))
}

/// `model` without the context window Claude Code may tag it with, as in
/// `claude-opus-5-5[1m]`.
fn untagged(model: &str) -> &str {
    model.split('[').next().unwrap_or(model)
}

/// What a model costs: one set of prices, or two for a model priced by
/// prompt length.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pricing {
    /// What every prompt pays, or with `long`, every prompt up to its
    /// length.
    pub base: Price,
    pub long: Option<Long>,
}

/// What a request pays on all of its tokens once its prompt is over
/// `over` tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Long {
    pub over: u64,
    pub price: Price,
}

impl Pricing {
    /// The prices a request pays whose prompt, its input, cache reads and
    /// cache writes together, is `prompt` tokens.
    pub fn at(&self, prompt: u64) -> Price {
        self.tier(self.long.is_some_and(|l| prompt > l.over))
    }

    /// The prices for a long prompt, or for a short one.
    pub fn tier(&self, long: bool) -> Price {
        match self.long {
            Some(l) if long => l.price,
            _ => self.base,
        }
    }

    /// The cost in dollars of one request, at the prices for its prompt.
    pub fn cost(&self, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
        self.at(input + cache_read + cache_write)
            .cost(input, output, cache_read, cache_write)
    }
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
        price(model, &BTreeMap::new()).map(|p| p.base)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn haiku_5_5_costs_five_times_as_much_over_100k_prompt_tokens() {
        let haiku = price("claude-haiku-5-5", &BTreeMap::new()).unwrap();
        let long = haiku.long.unwrap();
        assert_eq!(long.over, 100_000);
        assert_eq!(
            (
                long.price.input,
                long.price.output,
                long.price.cache_read,
                long.price.cache_write
            ),
            (0.50, 2.50, 0.05, 0.625)
        );
        // A prompt of 100,000 tokens is still a short one.
        assert!(close(
            haiku.cost(100_000, 1_000, 0, 0),
            (100_000. * 0.10 + 1_000. * 0.50) / 1e6
        ));
        // One more is a long one, and every token pays the higher price.
        assert!(close(
            haiku.cost(100_001, 1_000, 0, 0),
            (100_001. * 0.50 + 1_000. * 2.50) / 1e6
        ));
        // Cache reads and writes count toward the prompt.
        assert!(close(
            haiku.cost(1_000, 1_000, 90_000, 9_000),
            (1_000. * 0.10 + 1_000. * 0.50 + 90_000. * 0.01 + 9_000. * 0.125) / 1e6
        ));
        assert!(close(
            haiku.cost(1_000, 1_000, 90_000, 9_001),
            (1_000. * 0.50 + 1_000. * 2.50 + 90_000. * 0.05 + 9_001. * 0.625) / 1e6
        ));
        // Output is not part of the prompt.
        assert_eq!(haiku.at(100_000), haiku.base);
        assert!(close(
            haiku.cost(50_000, 200_000, 0, 0),
            (50_000. * 0.10 + 200_000. * 0.50) / 1e6
        ));
        assert!(is_long("claude-haiku-5-5-20261101", 100_001));
        assert!(!is_long("claude-haiku-5-5", 100_000));
    }

    #[test]
    fn gpt_models_cost_more_over_272k_input_tokens() {
        let sol = price("gpt-6-sol", &BTreeMap::new()).unwrap();
        assert_eq!(sol.long.unwrap().over, 272_000);
        assert!(close(
            sol.cost(72_000, 4_000, 200_000, 0),
            (72_000. * 2. + 4_000. * 10. + 200_000. * 0.20) / 1e6
        ));
        // Cached input counts toward the 272K.
        assert!(close(
            sol.cost(72_001, 4_000, 200_000, 0),
            (72_001. * 4. + 4_000. * 15. + 200_000. * 0.40) / 1e6
        ));
        assert!(is_long("gpt-6-sol", 272_001));
        assert!(!is_long("gpt-6-sol", 272_000));
        // Every GPT model slopmax prices doubles its input price there.
        for &(model, ..) in OPENAI {
            let p = price(model, &BTreeMap::new()).unwrap();
            let long = p
                .long
                .unwrap_or_else(|| panic!("{model} has no long price"));
            assert_eq!(long.over, 272_000, "{model}");
            assert!(close(long.price.input, p.base.input * 2.), "{model}");
            assert!(
                close(long.price.cache_write, long.price.input * 1.25),
                "{model}"
            );
        }
    }

    #[test]
    fn other_claude_models_cost_the_same_at_any_length() {
        for &(model, ..) in CLAUDE.iter().filter(|(m, ..)| *m != "claude-haiku-5-5") {
            let p = price(model, &BTreeMap::new()).unwrap();
            assert_eq!(p.long, None, "{model}");
            assert_eq!(p.at(900_000), p.base);
            assert!(!is_long(model, 900_000), "{model}");
        }
        // Every long price is for a model with a short one.
        for &(model, ..) in LONG {
            assert!(list(model).is_some(), "{model}");
        }
    }

    #[test]
    fn a_price_the_user_sets_holds_at_any_length() {
        let custom = BTreeMap::from([(
            "claude-haiku-5-5".to_owned(),
            Custom {
                input: 1.0,
                output: 2.0,
                cache_read: None,
                cache_write: None,
            },
        )]);
        let mine = price("claude-haiku-5-5", &custom).unwrap();
        assert_eq!(mine.long, None);
        assert_eq!(mine.tier(true), mine.base);
        assert!(close(mine.cost(500_000, 0, 0, 0), 0.5));
    }

    #[test]
    fn matches_a_model_or_its_dated_snapshots() {
        assert_eq!(list("claude-opus-5-5").unwrap().input, 4.0);
        assert_eq!(list("claude-opus-5").unwrap().input, 5.0);
        assert_eq!(list("claude-fable-5-2").unwrap().cache_read, 0.20);
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
    fn shares_follow_plan_sizes_only_when_every_one_is_known() {
        let shares = shares(
            ProviderId::Claude,
            &[Some("ultra"), Some("Max"), Some("pro")],
        )
        .unwrap();
        assert_eq!(shares, [10.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0]);
        // The old names size the same plans.
        let old = super::shares(ProviderId::Claude, &[Some("max 20x"), Some("Max 5x")]).unwrap();
        assert_eq!(old, [2.0 / 3.0, 1.0 / 3.0]);
        assert!(super::shares(ProviderId::Claude, &[Some("max 20x"), None]).is_none());
        assert!(super::shares(ProviderId::Codex, &[Some("pro"), Some("plus")]).is_none());
        assert!(super::shares(ProviderId::Claude, &[]).is_none());
    }

    #[test]
    fn plans_are_priced_by_provider_and_can_be_set() {
        let none = BTreeMap::new();
        assert_eq!(
            plan_monthly(ProviderId::Claude, "ultra", &none),
            Some(200.0)
        );
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
    fn openai_prices_charge_for_cache_writes() {
        let sol = list("gpt-6-sol").unwrap();
        assert_eq!(
            (sol.input, sol.output, sol.cache_read, sol.cache_write),
            (2.0, 10.0, 0.20, 2.5)
        );
        assert_eq!(list("gpt-6-luna").unwrap().output, 0.50);
    }

    /// The models both providers listed on 2026-11-14, at that day's
    /// list prices: (model, input, output, cache read).
    #[test]
    fn prices_every_listed_model() {
        let listed = [
            ("claude-fable-5-2", 8.0, 40.0, 0.20),
            ("claude-mythos-5-2", 8.0, 40.0, 0.20),
            ("claude-haiku-5-5", 0.10, 0.50, 0.01),
            ("claude-sonnet-5-5", 2.0, 10.0, 0.10),
            ("claude-opus-4-5-20251101", 5.0, 25.0, 0.50),
            ("claude-sonnet-4-5-20250929", 3.0, 15.0, 0.30),
            ("gpt-6-astra", 10.0, 50.0, 1.0),
            ("gpt-6.1-sol", 2.0, 10.0, 0.10),
            ("gpt-6.1-terra", 1.0, 5.0, 0.05),
            ("gpt-5.6-sol", 4.0, 20.0, 0.40),
            ("gpt-5.6-terra", 2.0, 12.0, 0.20),
            ("gpt-5.6-luna", 0.20, 1.20, 0.02),
        ];
        for (model, input, output, cache_read) in listed {
            let p = list(model).unwrap_or_else(|| panic!("{model} is unpriced"));
            assert_eq!(
                (p.input, p.output, p.cache_read),
                (input, output, cache_read),
                "{model}"
            );
        }
        // A point release is its own model, not the one it follows.
        assert_eq!(list("gpt-6.1-sol").unwrap().cache_read, 0.10);
        assert_eq!(list("gpt-6-sol").unwrap().cache_read, 0.20);
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
        let gpt = price("gpt-6-sol", &custom).unwrap().base;
        assert_eq!((gpt.cache_read, gpt.cache_write), (0.2, 2.5));
        let opus = price("claude-opus-5-5", &custom).unwrap().base;
        assert_eq!(
            (opus.input, opus.cache_read, opus.cache_write),
            (1.0, 0.5, 0.0)
        );
    }

    #[test]
    fn costs_every_kind_of_token() {
        let p = list("claude-sonnet-5-5").unwrap();
        // 1M of each: 2 + 10 + 0.10 + 2.50.
        let cost = p.cost(1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert!((cost - 14.60).abs() < 1e-9, "{cost}");
    }
}
