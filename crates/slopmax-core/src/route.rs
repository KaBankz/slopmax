//! Routing by model: which providers and accounts may serve a request, and
//! under which model name, in the order to try them.
//!
//! A request's model picks its providers: every provider with an account
//! that serves the model, subscriptions first. Pay-per-token accounts that
//! back up a subscription (an OpenAI key behind ChatGPT) join only as paid
//! overflow, unless there is no such subscription at all. On top of that:
//!
//! - an alias renames a model (`fast = "gpt-6-sol"`);
//! - a selector picks a provider or one account (`openai/gpt-6-sol`,
//!   `work/gpt-6-sol`);
//! - fallbacks name models to try once the first is spent everywhere.

use std::collections::BTreeMap;

use crate::account::Account;
use crate::agent;
use crate::provider::{Billing, ProviderId};
use crate::wire::Dialect;
use crate::wire::translate;

/// One way to serve a request: a provider, the model to ask it for, and
/// the accounts that may.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub provider: ProviderId,
    pub model: String,
    pub accounts: Vec<String>,
}

/// The configuration and accounts routing works from.
#[derive(Debug, Clone, Copy)]
pub struct Table<'a> {
    pub accounts: &'a [Account],
    pub aliases: &'a BTreeMap<String, String>,
    pub fallbacks: &'a BTreeMap<String, Vec<String>>,
    pub paid_overflow: bool,
}

/// A request to route.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub model: &'a str,
    /// The format the client speaks.
    pub dialect: Dialect,
    /// The agent the client identified itself as, by id.
    pub agent: Option<&'static str>,
    /// Serves models no provider claims: the API the request's path
    /// belongs to (`/codex/…` is ChatGPT's).
    pub default: Option<ProviderId>,
}

/// Why no account may serve a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoRoute {
    /// Accounts serve the model, but only to another agent.
    Refused {
        provider: ProviderId,
        agent: &'static str,
    },
    /// No account serves the model in the client's format.
    Unserved { model: String },
    /// The request names no model, and its path no provider.
    NoModel,
}

/// The steps that may serve `request`, in order.
pub fn plan(table: &Table, request: &Request) -> Result<Vec<Step>, NoRoute> {
    let mut steps = Vec::new();
    let mut refused = None;
    let primary = resolve(table, request.model);
    let fallbacks = table
        .fallbacks
        .get(request.model)
        .or_else(|| table.fallbacks.get(primary))
        .into_iter()
        .flatten()
        .map(|m| resolve(table, m));
    for (i, model) in std::iter::once(primary).chain(fallbacks).enumerate() {
        let default = request.default.filter(|_| i == 0);
        for step in steps_for(table, model, default) {
            match permitted(table, &step, request) {
                Ok(step) if !steps.contains(&step) => steps.push(step),
                Ok(_) => {}
                Err(no) => {
                    refused.get_or_insert(no);
                }
            }
        }
    }
    if steps.is_empty() {
        return Err(refused.unwrap_or(NoRoute::Unserved {
            model: request.model.to_owned(),
        }));
    }
    Ok(steps)
}

/// The model an alias stands for.
fn resolve<'a>(table: &'a Table, model: &'a str) -> &'a str {
    table.aliases.get(model).map_or(model, String::as_str)
}

/// Every provider step for `model`, before policy.
fn steps_for(table: &Table, model: &str, default: Option<ProviderId>) -> Vec<Step> {
    let serving = |provider: ProviderId, model: &str| -> Vec<String> {
        table
            .accounts
            .iter()
            .filter(|a| a.provider == provider && provider.get().serves(a, model))
            .map(|a| a.id.clone())
            .collect()
    };
    let has_accounts = |provider: ProviderId| table.accounts.iter().any(|a| a.provider == provider);

    let mut steps = Vec::new();
    for provider in ProviderId::ALL {
        let accounts = serving(provider, model);
        if accounts.is_empty() {
            continue;
        }
        if let Billing::Metered { backs: Some(sub) } = provider.spec().billing
            && has_accounts(sub)
            && !table.paid_overflow
        {
            continue;
        }
        steps.push(Step {
            provider,
            model: model.to_owned(),
            accounts,
        });
    }
    if !steps.is_empty() {
        return steps;
    }
    // A selector: `openai/gpt-6-sol` or `work/gpt-6-sol`. Checked only
    // when no account serves the whole name, since model ids such as
    // `qwen/qwen3-coder` contain slashes too.
    if let Some((prefix, rest)) = model.split_once('/') {
        if let Ok(provider) = prefix.parse::<ProviderId>() {
            let accounts: Vec<String> = table
                .accounts
                .iter()
                .filter(|a| a.provider == provider)
                .map(|a| a.id.clone())
                .collect();
            if !accounts.is_empty() {
                steps.push(Step {
                    provider,
                    model: rest.to_owned(),
                    accounts,
                });
            }
            return steps;
        }
        if let Some(account) = table.accounts.iter().find(|a| {
            a.id == prefix
                || a.label.as_deref() == Some(prefix)
                || a.email.as_deref() == Some(prefix)
        }) {
            steps.push(Step {
                provider: account.provider,
                model: rest.to_owned(),
                accounts: vec![account.id.clone()],
            });
            return steps;
        }
    }
    if let Some(provider) = default.filter(|p| has_accounts(*p)) {
        steps.push(Step {
            provider,
            model: model.to_owned(),
            accounts: table
                .accounts
                .iter()
                .filter(|a| a.provider == provider)
                .map(|a| a.id.clone())
                .collect(),
        });
    }
    steps
}

/// The step as far as policy and format allow: accounts that may serve
/// this client, in its own format or by translation.
fn permitted(table: &Table, step: &Step, request: &Request) -> Result<Step, NoRoute> {
    let provider = step.provider.get();
    if let Some(only) = provider.spec().agent_only
        && request.agent != Some(only)
    {
        let agent = agent::find(only).map_or(only, |a| a.title());
        return Err(NoRoute::Refused {
            provider: step.provider,
            agent,
        });
    }
    let accounts: Vec<String> = step
        .accounts
        .iter()
        .filter(|id| {
            table
                .accounts
                .iter()
                .find(|a| &a.id == *id)
                .is_some_and(|a| {
                    provider.dialects(a).iter().any(|d| {
                        *d == request.dialect || translate::can_translate(request.dialect, *d)
                    })
                })
        })
        .cloned()
        .collect();
    if accounts.is_empty() {
        return Err(NoRoute::Unserved {
            model: step.model.clone(),
        });
    }
    Ok(Step {
        accounts,
        ..step.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{Endpoint, Tokens};

    fn account(provider: ProviderId, key: &str) -> Account {
        let mut account = Account::new(
            provider,
            Tokens {
                access_token: key.into(),
                refresh_token: Some(key.into()),
                ..Tokens::default()
            },
        );
        account.label = Some(key.into());
        account
    }

    fn compat(label: &str, dialect: Dialect, models: &[&str]) -> Account {
        let mut account = account(ProviderId::Compat, label);
        account.endpoint = Some(Endpoint {
            base_url: format!("http://{label}/v1"),
            dialect,
            models: models.iter().map(|m| m.to_string()).collect(),
        });
        account.assign_id();
        account
    }

    struct Fixture {
        accounts: Vec<Account>,
        aliases: BTreeMap<String, String>,
        fallbacks: BTreeMap<String, Vec<String>>,
        paid_overflow: bool,
    }

    impl Fixture {
        fn new(accounts: Vec<Account>) -> Self {
            Self {
                accounts,
                aliases: BTreeMap::new(),
                fallbacks: BTreeMap::new(),
                paid_overflow: false,
            }
        }

        fn plan(
            &self,
            model: &str,
            dialect: Dialect,
            agent: Option<&'static str>,
        ) -> Result<Vec<(ProviderId, String)>, NoRoute> {
            let table = Table {
                accounts: &self.accounts,
                aliases: &self.aliases,
                fallbacks: &self.fallbacks,
                paid_overflow: self.paid_overflow,
            };
            let default = match dialect {
                Dialect::Messages => Some(ProviderId::Claude),
                Dialect::Responses => Some(ProviderId::Codex),
                Dialect::Chat => None,
            };
            let request = Request {
                model,
                dialect,
                agent,
                default,
            };
            plan(&table, &request)
                .map(|steps| steps.into_iter().map(|s| (s.provider, s.model)).collect())
        }
    }

    use Dialect::{Chat, Messages, Responses};
    use ProviderId::{Anthropic, Claude, Codex, Compat, OpenAI, Xai};

    fn step(provider: ProviderId, model: &str) -> (ProviderId, String) {
        (provider, model.to_owned())
    }

    #[test]
    fn subscriptions_come_first_and_keys_only_as_paid_overflow() {
        let mut f = Fixture::new(vec![
            account(Codex, "chatgpt"),
            account(OpenAI, "key"),
            account(Claude, "max"),
            account(Anthropic, "ant"),
        ]);
        let codex = Some("codex");
        assert_eq!(
            f.plan("gpt-6-sol", Responses, codex),
            Ok(vec![step(Codex, "gpt-6-sol")])
        );
        assert_eq!(
            f.plan("claude-opus-5-5", Messages, Some("claude")),
            Ok(vec![step(Claude, "claude-opus-5-5")])
        );
        f.paid_overflow = true;
        assert_eq!(
            f.plan("gpt-6-sol", Responses, codex),
            Ok(vec![step(Codex, "gpt-6-sol"), step(OpenAI, "gpt-6-sol")])
        );
        // Without a subscription to back up, a key serves directly.
        let f = Fixture::new(vec![account(OpenAI, "key")]);
        assert_eq!(
            f.plan("gpt-6-sol", Responses, codex),
            Ok(vec![step(OpenAI, "gpt-6-sol")])
        );
    }

    #[test]
    fn claude_models_serve_claude_code_only() {
        let f = Fixture::new(vec![account(Claude, "max"), account(Anthropic, "ant")]);
        assert_eq!(
            f.plan("claude-opus-5-5", Messages, None),
            Err(NoRoute::Refused {
                provider: Claude,
                agent: "Claude Code"
            })
        );
        // And never in another format.
        assert_eq!(
            f.plan("claude-opus-5-5", Chat, Some("claude")),
            Err(NoRoute::Unserved {
                model: "claude-opus-5-5".into()
            })
        );
    }

    #[test]
    fn models_find_their_provider_in_the_clients_format() {
        let f = Fixture::new(vec![
            account(Codex, "chatgpt"),
            account(Xai, "grok"),
            compat("local", Chat, &["qwen3-*"]),
            compat("kimi", Messages, &["kimi-*"]),
        ]);
        assert_eq!(f.plan("grok-4", Chat, None), Ok(vec![step(Xai, "grok-4")]));
        assert_eq!(
            f.plan("qwen3-coder", Chat, None),
            Ok(vec![step(Compat, "qwen3-coder")])
        );
        // Claude Code may use another vendor's Messages endpoint.
        assert_eq!(
            f.plan("kimi-k2", Messages, Some("claude")),
            Ok(vec![step(Compat, "kimi-k2")])
        );
        // Codex sends unclaimed models to ChatGPT, as before routing.
        assert_eq!(
            f.plan("o5-mini", Responses, Some("codex")),
            Ok(vec![step(Codex, "o5-mini")])
        );
        // Other formats reach ChatGPT by translation, never Messages APIs.
        assert_eq!(
            f.plan("gpt-6-sol", Messages, Some("claude")),
            Ok(vec![step(Codex, "gpt-6-sol")])
        );
        assert_eq!(
            f.plan("gpt-6-sol", Chat, None),
            Ok(vec![step(Codex, "gpt-6-sol")])
        );
        assert_eq!(
            f.plan("kimi-k2", Chat, None),
            Err(NoRoute::Unserved {
                model: "kimi-k2".into()
            })
        );
        assert_eq!(
            f.plan("nope", Chat, None),
            Err(NoRoute::Unserved {
                model: "nope".into()
            })
        );
    }

    #[test]
    fn selectors_aliases_and_fallbacks() {
        let mut f = Fixture::new(vec![
            account(Codex, "work"),
            account(Codex, "home"),
            account(OpenAI, "key"),
            compat("router", Chat, &["qwen/*"]),
        ]);
        let codex = Some("codex");
        // A provider selector opts into a key for one request.
        assert_eq!(
            f.plan("openai/gpt-6-sol", Responses, codex),
            Ok(vec![step(OpenAI, "gpt-6-sol")])
        );
        // An account selector pins one account.
        let table = Table {
            accounts: &f.accounts,
            aliases: &f.aliases,
            fallbacks: &f.fallbacks,
            paid_overflow: false,
        };
        let request = Request {
            model: "home/gpt-6-sol",
            dialect: Responses,
            agent: codex,
            default: Some(Codex),
        };
        let steps = plan(&table, &request).unwrap();
        assert_eq!(steps[0].accounts, [f.accounts[1].id.clone()]);
        // A model id with a slash is a model when an account serves it.
        assert_eq!(
            f.plan("qwen/qwen3-coder", Chat, None),
            Ok(vec![step(Compat, "qwen/qwen3-coder")])
        );

        f.aliases.insert("fast".into(), "gpt-6-sol-mini".into());
        f.fallbacks
            .insert("gpt-6-sol".into(), vec!["openai/gpt-6-sol".into()]);
        assert_eq!(
            f.plan("fast", Responses, codex),
            Ok(vec![step(Codex, "gpt-6-sol-mini")])
        );
        assert_eq!(
            f.plan("gpt-6-sol", Responses, codex),
            Ok(vec![step(Codex, "gpt-6-sol"), step(OpenAI, "gpt-6-sol")])
        );
    }
}
