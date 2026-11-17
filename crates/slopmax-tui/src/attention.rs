//! What wants a look on the accounts: the overview lists it, and a
//! provider's mark in the sidebar takes its worst tone.

use slopmax_client::api::report::{Condition, Report};
use slopmax_client::api::{NoticeKind, Provider, Span, Tone};
use slopmax_common::time::SignedDuration;

use crate::app::held_resets;
use crate::format::{self, Now};

/// Something about an account that wants a look.
#[derive(Debug, Clone, PartialEq)]
pub struct Attention {
    pub provider: Provider,
    /// The account it is about, by id.
    pub account: String,
    pub text: String,
    pub tone: Tone,
    pub remedy: Remedy,
}

/// What can be done about it from the overview, besides opening the
/// account (⏎).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remedy {
    /// `R` redeems one of the account's limit resets.
    Redeem,
    /// Only a look: ⏎ opens the account.
    Show,
    /// Signing in again, which `slopmax login` does.
    SignIn,
}

/// What wants a look, most pressing first: an account signed out, one
/// limited that holds a limit reset, a window running out before it
/// resets, a limit reset soon to expire, then the report's nudges. An
/// account merely limited is slopmax's to work around.
pub fn attention(report: &Report, now: &Now) -> Vec<Attention> {
    let mut found = Vec::new();
    let three_days = SignedDuration::from_hours(72);
    for account in report.accounts.iter().filter(|a| !a.disabled) {
        let held = held_resets(account, now.at);
        let item = |text: String, tone: Tone, remedy| Attention {
            provider: account.provider,
            account: account.id.clone(),
            text,
            tone,
            remedy,
        };
        match account.condition.at(now.at) {
            Condition::SignInNeeded { .. } => {
                found.push(item(
                    format!("{} needs signing in again", account.name),
                    Tone::Bad,
                    Remedy::SignIn,
                ));
                continue;
            }
            Condition::Limited { until } if held > 0 => found.push(item(
                format!(
                    "{} is limited until {}, and holds {}",
                    account.name,
                    now.clock(until),
                    format::count(held, "limit reset")
                ),
                Tone::Warn,
                Remedy::Redeem,
            )),
            _ => {}
        }
        for window in account.windows.iter().filter(|w| w.model.is_none()) {
            if let Some((text, Tone::Warn)) = format::pace(window, now) {
                let title = format::span_title(window.span).to_lowercase();
                found.push(item(
                    format!(
                        "{}'s {title} window {}",
                        account.name,
                        lowercase_first(&text)
                    ),
                    Tone::Warn,
                    Remedy::Show,
                ));
            }
        }
        let expiring = account
            .unexpired_resets(now.at)
            .filter_map(|r| r.expires_at)
            .find(|at| at.duration_since(now.at) < three_days);
        if let Some(at) = expiring {
            found.push(item(
                format!(
                    "A limit reset on {} expires in {} · {}",
                    account.name,
                    now.until(at),
                    now.clock(at)
                ),
                Tone::Warn,
                Remedy::Redeem,
            ));
        }
    }
    for nudge in &report.nudges {
        let Some(account) = report.accounts.iter().find(|a| {
            nudge.account.as_deref() == Some(a.name.as_str())
                && nudge.provider.is_none_or(|p| p == a.provider)
        }) else {
            continue;
        };
        let already = found
            .iter()
            .any(|f| f.account == account.id && f.remedy == Remedy::Redeem);
        match nudge.kind {
            NoticeKind::ResetExpiring if !already => found.push(Attention {
                provider: account.provider,
                account: account.id.clone(),
                text: first_sentence(&nudge.message),
                tone: Tone::Warn,
                remedy: Remedy::Redeem,
            }),
            NoticeKind::QuotaUnused => {
                let at = nudge.until.unwrap_or(now.at);
                let (period, unused) = match account.long_window() {
                    Some(w) => (
                        if w.span == Span::Month {
                            "month"
                        } else {
                            "week"
                        },
                        100.0 - w.used_at(now.at).clamp(0.0, 100.0),
                    ),
                    None => ("week", 0.0),
                };
                let worth = match nudge.worth {
                    Some(worth) if worth >= 0.5 => format!(", about ${worth:.0} of its plan"),
                    _ => String::new(),
                };
                found.push(Attention {
                    provider: account.provider,
                    account: account.id.clone(),
                    text: format!(
                        "{}'s {period} resets in {} · {} with {unused:.0}% of it unused{worth}",
                        account.name,
                        now.until(at),
                        now.clock(at)
                    ),
                    tone: Tone::Warn,
                    remedy: Remedy::Show,
                });
            }
            _ => {}
        }
    }
    found.sort_by_key(|f| f.tone != Tone::Bad);
    found
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A notice's first sentence, without its full stop or the marks around a
/// command.
fn first_sentence(message: &str) -> String {
    let first = message.split(". ").next().unwrap_or(message);
    first.trim_end_matches('.').replace('`', "")
}
