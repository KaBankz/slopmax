//! `slopmax usage`: token totals and API-equivalent cost from the ledger,
//! by day, model, or account.

use std::collections::HashMap;

use anyhow::{Result, bail};

use crate::ui;
use slopmax_core::account::Store;
use slopmax_core::config::Config;
use slopmax_core::summary::{self, Totals};
use slopmax_core::time::Timestamp;
use slopmax_core::{human, waste};

/// Prints usage since the start of `range` (`today`, `7d`, `30d`, `all`),
/// grouped `by` day, model, or account.
pub fn run(config: &Config, store: &Store, range: &str, by: &str, json: bool) -> Result<()> {
    let Some(since) = summary::since(range, Timestamp::now()) else {
        bail!("unknown range {range:?}; use today, 7d, 30d, or all");
    };
    let names: HashMap<String, String> = store
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.id.clone(), a.name()))
        .collect();
    let report = summary::build(&super::home().usage(), since, by, &config.prices, &names);
    let (rows, total) = (&report.rows, &report.total);
    let lapsed = waste::read(&super::home().windows(), since);
    let left = waste::left(&lapsed, &config.plan_prices, &names);

    if json {
        let mut value = serde_json::to_value(&report)?;
        value["left_on_the_table"] = serde_json::to_value(&left)?;
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let title = match range {
        "today" => "today".to_owned(),
        "all" => "all time".to_owned(),
        days => format!("the last {} days", days.trim_end_matches('d')),
    };
    if total.requests == 0 && total.failed == 0 {
        println!("No requests recorded for {title}.");
        return Ok(());
    }
    let width = rows
        .keys()
        .map(|k| ui::visible_width(k))
        .max()
        .unwrap_or(0)
        .max(5);
    let header = by.to_uppercase();
    println!(
        "\n{}  {:>6}  {:>8}  {:>8}  {:>10}  {:>11}  {:>9}",
        ui::bold(ui::pad(&header, width)),
        ui::dim("REQ"),
        ui::dim("INPUT"),
        ui::dim("OUTPUT"),
        ui::dim("CACHE READ"),
        ui::dim("CACHE WRITE"),
        ui::dim("API COST")
    );
    let line = |label: &str, t: &Totals| {
        format!(
            "{}  {:>6}  {:>8}  {:>8}  {:>10}  {:>11}  {:>9}",
            ui::pad(label, width),
            t.requests,
            human::compact(t.input),
            human::compact(t.output),
            human::compact(t.cache_read),
            human::compact(t.cache_write),
            t.cost_label()
        )
    };
    for (label, totals) in rows {
        println!("{}", line(label, totals));
    }
    println!("{}", ui::bold(line("total", total)));
    let mut note = format!(
        "Usage for {title}. API cost is what these requests would cost at API list \
         prices (Anthropic's as of 2026-09, and any set in config.toml)."
    );
    if total.unpriced > 0 {
        let n = total.unpriced;
        note.push_str(&format!(
            "\n+ leaves out {n} request{} to models without a price; set one under \
             [prices] in {}.",
            if n == 1 { "" } else { "s" },
            super::home().config().display()
        ));
    }
    if total.failed > 0 {
        let n = total.failed;
        note.push_str(&format!(
            "\n{n} request{} failed (the provider answered with an error, or no account \
             could take it) and {} left out.",
            if n == 1 { "" } else { "s" },
            if n == 1 { "is" } else { "are" },
        ));
    }
    println!("\n{}", ui::dim(note));
    print_left(&left);
    Ok(())
}

/// What the weeks that reset left unused, and what that part of the plans
/// cost.
fn print_left(left: &waste::Left) {
    if left.windows == 0 {
        return;
    }
    let windows = format!(
        "{} weekly window{}",
        left.windows,
        if left.windows == 1 { "" } else { "s" }
    );
    println!(
        "
{} {}, {:.0}% unused on average, across {windows}",
        ui::bold("Left on the table:"),
        ui::bold(format!("${:.2}", left.dollars)),
        left.unused,
    );
    for account in left.accounts.iter().filter(|a| a.unused >= 0.5) {
        println!(
            "  {}  {:>7}  {}",
            ui::pad(&account.name, 28),
            format!("${:.2}", account.dollars),
            ui::dim(format!(
                "{:.0}% unused over {}",
                account.unused, account.windows
            )),
        );
    }
    let mut note = "What each plan costs for the part of its weekly quota a reset threw away. \
                    `slopmax status` shows what is left this week."
        .to_owned();
    if left.unpriced > 0 {
        note.push_str(" Plans without a known price are left out; set them under [plan_prices].");
    }
    println!("{}", ui::dim(note));
}
