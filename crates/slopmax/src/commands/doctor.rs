//! `slopmax doctor`: prints the setup checks from [`slopmax_core::doctor`].

use anyhow::Result;

use crate::ui;
use slopmax_core::account::Store;
use slopmax_core::config::Config;
use slopmax_core::doctor::{self, Level};

/// Prints every finding and returns the exit code: 1 if something is
/// broken.
pub async fn run(config: &Config, store: &Store) -> Result<i32> {
    let mut worst = Level::Ok;
    let (mut problems, mut warnings) = (0, 0);
    for section in doctor::check(config, store).await? {
        println!("\n{}", ui::bold(section.title));
        for finding in &section.findings {
            let mark = match finding.level {
                Level::Ok => ui::green("✓"),
                Level::Note => ui::dim("·"),
                Level::Warn => ui::yellow("!"),
                Level::Fail => ui::red("✗"),
            };
            println!("  {mark} {}", finding.text);
            if let Some(fix) = &finding.fix {
                println!("      {} {fix}", ui::dim("fix:"));
            }
            worst = worst.max(finding.level);
            problems += usize::from(finding.level == Level::Fail);
            warnings += usize::from(finding.level == Level::Warn);
        }
    }
    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    println!();
    match (problems, warnings) {
        (0, 0) => println!("{}", ui::green("Everything looks good.")),
        _ => println!(
            "{}, {}.",
            plural(problems, "problem"),
            plural(warnings, "warning")
        ),
    }
    Ok(i32::from(worst == Level::Fail))
}
