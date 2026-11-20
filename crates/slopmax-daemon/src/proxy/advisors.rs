//! Which account made each of Claude's advisor calls.
//!
//! Claude seals an advisor's result to the account that made the call and
//! refuses it from any other, so a conversation that moves to another
//! account would carry the old account's results there and be refused;
//! Claude Code then drops every advisor result in the conversation, the new
//! account's too. Knowing who made each call, slopmax leaves behind only
//! the results the new account cannot read, and keeps the ones it made.

use std::collections::{HashMap, VecDeque};

#[derive(Debug, Default)]
pub struct Advisors {
    owners: HashMap<String, String>,
    order: VecDeque<String>,
}

impl Advisors {
    /// Calls remembered at most; the oldest go first. One forgotten is sent
    /// as is, and if Claude refuses it the request goes again without any.
    const MAX: usize = 8192;

    /// Records that `account` made the advisor call `call`.
    pub fn remember(&mut self, call: String, account: &str) {
        if self.owners.contains_key(&call) {
            return;
        }
        if self.owners.len() >= Self::MAX
            && let Some(oldest) = self.order.pop_front()
        {
            self.owners.remove(&oldest);
        }
        self.order.push_back(call.clone());
        self.owners.insert(call, account.to_owned());
    }

    /// Whether `account` can read the result of the advisor call `call`: it
    /// made the call, or slopmax did not see who did.
    pub fn readable(&self, call: &str, account: &str) -> bool {
        self.owners.get(call).is_none_or(|owner| owner == account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_belong_to_the_account_that_made_them() {
        let mut advisors = Advisors::default();
        advisors.remember("s1".into(), "claude-a");
        // A later sighting of the same call does not change its maker.
        advisors.remember("s1".into(), "claude-b");
        assert!(advisors.readable("s1", "claude-a"));
        assert!(!advisors.readable("s1", "claude-b"));
        assert!(advisors.readable("unseen", "claude-b"));
    }

    #[test]
    fn the_oldest_calls_are_forgotten_first() {
        let mut advisors = Advisors::default();
        for i in 0..=Advisors::MAX {
            advisors.remember(format!("s{i}"), "claude-a");
        }
        assert_eq!(advisors.owners.len(), Advisors::MAX);
        assert!(advisors.readable("s0", "claude-b"));
        assert!(!advisors.readable("s1", "claude-b"));
    }
}
