//! Whether this machine is awake enough to send a refresh token.
//!
//! A sleeping Mac wakes for a few seconds at a time to do maintenance (a
//! "DarkWake"), and a background refresh can come due in one. The provider
//! rotates the single-use refresh token, but the Mac may be asleep again
//! before the reply arrives: the new token is lost, the old one is spent,
//! and the account needs a new sign-in. So a refresh waits for a full wake.

/// Why a refresh should wait, or `None` when it may go ahead. A state that
/// can't be read never holds a refresh back: a token that is never
/// refreshed signs the account out too.
pub async fn deferral() -> Option<String> {
    held(&system_state().await?)
}

/// What `pmset -g systemstate` reports, on macOS.
#[cfg(target_os = "macos")]
async fn system_state() -> Option<String> {
    use std::process::Stdio;
    use std::time::Duration;

    let output = tokio::process::Command::new("/usr/bin/pmset")
        .args(["-g", "systemstate"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(2), output)
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Other systems wake whole.
#[cfg(not(target_os = "macos"))]
async fn system_state() -> Option<String> {
    None
}

/// Reads pmset's capabilities: a full wake has both Graphics and Network,
/// a maintenance wake lacks Graphics. A report without the line holds
/// nothing back.
fn held(state: &str) -> Option<String> {
    let capabilities: Vec<&str> = state
        .lines()
        .find_map(|line| line.trim().strip_prefix("Current System Capabilities are:"))?
        .split_whitespace()
        .collect();
    if capabilities.contains(&"Graphics") && capabilities.contains(&"Network") {
        return None;
    }
    Some(format!(
        "token refresh deferred: the Mac is in a maintenance wake ({})",
        capabilities.join(" ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_maintenance_wake_holds_refreshes_back() {
        let full =
            "Current System Capabilities are: CPU Graphics Audio Network\nCurrent Power State: 4\n";
        assert_eq!(held(full), None);
        let dark = "Current System Capabilities are: CPU Network\nCurrent Power State: 4\n";
        assert_eq!(
            held(dark).as_deref(),
            Some("token refresh deferred: the Mac is in a maintenance wake (CPU Network)")
        );
        assert!(held("Current System Capabilities are: CPU Graphics Audio").is_some());
        assert!(held("Current System Capabilities are:").is_some());
    }

    #[test]
    fn an_unreadable_state_holds_nothing_back() {
        assert_eq!(held(""), None);
        assert_eq!(held("pmset: unknown option"), None);
    }

    /// The machine running the tests is fully awake, so the real report
    /// must read that way: on a headless Mac too, which runs slopmax as a
    /// service.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn this_mac_reads_as_awake() {
        let state = system_state()
            .await
            .expect("pmset reports the system state");
        assert!(
            state.contains("Current System Capabilities are:"),
            "{state}"
        );
        assert_eq!(held(&state), None, "{state}");
    }
}
