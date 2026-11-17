//! `slopmax requests`: the requests the proxy answered, newest first, as
//! the dashboard's Requests page lists them. The running proxy (or the hub)
//! reads them from its usage ledger; with none, the CLI reads it itself.

use std::collections::HashMap;

use anyhow::Result;

use super::{Ctx, daemon, home};
use crate::cli::{Requests, RequestsRange};
use crate::ui;
use slopmax_client::RequestQuery;
use slopmax_client::api::ledger::{HistoryRange, LedgerRecord, RequestOutcome, RequestPage};
use slopmax_core::time::Timestamp;
use slopmax_core::{api, browse, human, ledger, summary};

pub(super) async fn run(ctx: &Ctx, r: Requests) -> Result<()> {
    let config = &ctx.config;
    let client = daemon(config).await?;
    let range = match r.range {
        RequestsRange::Today => HistoryRange::Today,
        RequestsRange::Week => HistoryRange::Week,
        RequestsRange::Month => HistoryRange::Month,
    };
    // The ledger records an account by its id.
    let account = match &r.account {
        Some(query) => Some(
            super::accounts::find(config, &ctx.store, client.as_ref(), query)
                .await?
                .id,
        ),
        None => None,
    };
    let query = RequestQuery {
        range,
        outcome: if r.failed {
            RequestOutcome::Failed
        } else {
            RequestOutcome::All
        },
        account,
        model: r.model,
        offset: r.offset as u64,
        limit: r.limit.clamp(1, browse::MOST) as u64,
    };
    let page = match &client {
        Some(client) => client.requests(&query).await?,
        None => offline(config, &query),
    };
    if r.json.json {
        println!("{}", serde_json::to_string_pretty(&page)?);
        return Ok(());
    }
    // The ledger names accounts by id; people know them by name.
    let report = super::status::report(config, &ctx.store, client.as_ref()).await?;
    let names: HashMap<&str, &str> = report
        .accounts
        .iter()
        .map(|a| (a.id.as_str(), a.name.as_str()))
        .collect();
    print(&page, &names);
    Ok(())
}

/// The page read from this home's ledger, while no proxy runs.
fn offline(config: &slopmax_core::config::Config, query: &RequestQuery) -> RequestPage {
    let now = Timestamp::now();
    let since = summary::since(api::history_range(query.range).key(), now)
        .expect("every range has a start");
    let entries = ledger::read(&home().usage(), since);
    let asked = browse::Query {
        account: query.account.clone(),
        model: query.model.clone(),
        agent: None,
        outcome: query.outcome,
        offset: query.offset as usize,
        limit: query.limit as usize,
    };
    browse::page(&entries, &asked, query.range, since, &config.prices)
}

fn print(page: &RequestPage, names: &HashMap<&str, &str>) {
    if page.rows.is_empty() {
        println!("No requests in this range.");
        return;
    }
    let now = Timestamp::now();
    let rows: Vec<[String; 6]> = page
        .rows
        .iter()
        .map(|row| {
            let LedgerRecord::Request(r) = &row.record;
            let status = if r.status < 400 {
                ui::green(r.status)
            } else {
                ui::red(r.status)
            };
            let moved = if r.attempts > 1 {
                ui::yellow(format!(" ↻{}", r.attempts - 1))
            } else {
                String::new()
            };
            [
                ui::dim(format!("{} ago", human::duration(now.duration_since(r.at)))),
                format!("{status}{moved}"),
                r.model.clone().unwrap_or_else(|| "-".into()),
                match r.account.as_deref() {
                    None | Some("") => "-".to_owned(),
                    Some(id) => names.get(id).copied().unwrap_or(id).to_owned(),
                },
                human::compact(r.usage.tokens()),
                row.cost
                    .map(|c| format!("${c:.2}"))
                    .unwrap_or_else(|| "-".into()),
            ]
        })
        .collect();
    let widths: Vec<usize> = (0..6)
        .map(|i| {
            rows.iter()
                .map(|r| ui::visible_width(&r[i]))
                .max()
                .unwrap_or(0)
        })
        .collect();
    for row in &rows {
        let cells: Vec<String> = row
            .iter()
            .zip(&widths)
            .enumerate()
            .map(|(i, (cell, width))| {
                if i >= 4 {
                    format!("{}{cell}", " ".repeat(width - ui::visible_width(cell)))
                } else {
                    ui::pad(cell, *width)
                }
            })
            .collect();
        println!("{}", cells.join("  ").trim_end());
    }
    let shown = page.rows.len() as u64;
    let more = if page.matched > page.offset + shown {
        format!(
            " ({shown} shown; --offset {} shows the next)",
            page.offset + shown
        )
    } else {
        String::new()
    };
    println!(
        "\n{}",
        ui::dim(format!(
            "{} requests{more} · {} failed · {} moved to another account · {} tokens · ${:.2}",
            page.matched,
            page.failed,
            page.rescued,
            human::compact(page.tokens),
            page.cost
        ))
    );
}
