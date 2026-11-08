//! Notifications on the desktop for what the daemon tells: an account
//! limited or back, every account spent, a limit reset about to lapse, a
//! week about to reset with quota to spare. The daemon decides what is worth
//! telling and tells each once, across restarts too; the app only words and
//! posts them. The UI posts each [`Alert`] the system's way.

use slopmax_api::NoticeKind;
use slopmax_api::report::Notice;

/// A notification's title for a notice.
pub fn title(kind: NoticeKind) -> &'static str {
    match kind {
        NoticeKind::ResetExpiring => "Limit reset expiring",
        NoticeKind::QuotaUnused => "Quota going unused",
        NoticeKind::Exhausted => "Every account is limited",
        NoticeKind::Recovered => "Accounts are back",
        NoticeKind::SignedOut => "Sign in again",
        NoticeKind::Limited => "Account limited",
        NoticeKind::Available => "Account available",
        NoticeKind::Test => "slopmax",
    }
}

/// A notification for the UI to post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    /// The notice's key: a notification posted again under it replaces the
    /// last rather than stacking beside it.
    pub key: String,
    pub title: &'static str,
    pub body: String,
}

impl Alert {
    /// A notice's words as a notification shows them: the daemon's, without
    /// the marks that set off a command in a terminal.
    pub fn of(notice: &Notice) -> Self {
        Self {
            key: notice.key.clone(),
            title: title(notice.kind),
            body: notice.message.replace('`', ""),
        }
    }
}

#[cfg(test)]
mod tests {
    use slopmax_common::time::Timestamp;

    use super::*;

    #[test]
    fn a_notification_reads_plainly() {
        let now = Timestamp::from_second(1_000_000).unwrap();
        let notice = Notice {
            kind: NoticeKind::ResetExpiring,
            key: "reset:a:1".to_owned(),
            provider: Some(slopmax_api::Provider::Codex),
            account: Some("codex0".to_owned()),
            until: Some(now),
            message: "A limit reset on codex0 expires; redeem it with `slopmax redeem codex0`."
                .to_owned(),
            at: now,
            worth: None,
        };
        assert_eq!(title(NoticeKind::QuotaUnused), "Quota going unused");
        let alert = Alert::of(&notice);
        assert_eq!(alert.key, "reset:a:1");
        assert_eq!(alert.title, "Limit reset expiring");
        assert_eq!(
            alert.body,
            "A limit reset on codex0 expires; redeem it with slopmax redeem codex0."
        );
    }
}
