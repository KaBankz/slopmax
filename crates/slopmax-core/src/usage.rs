//! Reads each account's usage windows from its provider's usage endpoint.

use anyhow::{Result, anyhow, bail};

use crate::account::{Account, Store};
use crate::auth::{self, RefreshError};
use crate::net::Client;
use crate::provider::{Reading, UsageError};

/// Polls one account, refreshing its token first when due (if `refresh` is
/// allowed) and retrying once after a forced refresh if the token is
/// rejected. Returns the possibly refreshed account alongside the reading.
pub async fn poll(
    http: &Client,
    store: &Store,
    account: &Account,
    refresh: bool,
) -> Result<(Account, Reading)> {
    let mut account = account.clone();
    if refresh {
        account = fresh(http, store, &account, false).await?;
    }
    let provider = account.provider.get();
    match provider.usage(http, &account).await {
        Ok(reading) => Ok((account, reading)),
        Err(UsageError::Other(e)) => Err(e),
        Err(UsageError::Unauthorized) if refresh => {
            account = fresh(http, store, &account, true).await?;
            match provider.usage(http, &account).await {
                Ok(reading) => Ok((account, reading)),
                Err(UsageError::Unauthorized) => bail!("token rejected after refresh"),
                Err(UsageError::Other(e)) => Err(e),
            }
        }
        Err(UsageError::Unauthorized) => bail!("token rejected (refresh disabled)"),
    }
}

async fn fresh(http: &Client, store: &Store, account: &Account, force: bool) -> Result<Account> {
    auth::ensure_fresh(http, store, account, force)
        .await
        .map_err(|e| match e {
            RefreshError::Revoked(reason) => {
                anyhow!("{reason}; run `slopmax login {}`", account.provider)
            }
            RefreshError::Transient(e) => e,
        })
}
