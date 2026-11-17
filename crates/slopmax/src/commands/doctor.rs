//! `slopmax doctor`: prints the setup checks from [`slopmax_core::doctor`].

use anyhow::Result;

use crate::ui;
use slopmax_core::account::Store;
use slopmax_core::config::Config;
use slopmax_core::doctor::{self, Level};
use slopmax_core::error::ConfigError;

/// Prints every finding and returns the exit code: 1 if something is
/// broken.
///
/// `broken` is why config.toml did not read, when it did not: the other
/// checks run on what of it could be read.
pub async fn run(
    config: &Config,
    store: &Store,
    broken: Option<&ConfigError>,
    json: bool,
) -> Result<i32> {
    let mut worst = Level::Ok;
    let (mut problems, mut warnings) = (0, 0);
    let ts = slopmax_core::tailscale::Tailscale::find().ok();
    let mut sections = doctor::check(config, store, super::home(), ts).await?;
    if let Some(error) = broken {
        let (text, fix) = match error {
            ConfigError::Invalid { path, message } => (
                format!("{} does not read: {message}", path.display()),
                "fix that line, or delete it to use the default".to_owned(),
            ),
            other => (
                other.to_string(),
                format!("edit {}", super::home().config().display()),
            ),
        };
        let finding = doctor::Finding {
            level: Level::Fail,
            text,
            fix: Some(fix),
        };
        sections.insert(
            0,
            doctor::Section {
                title: "Config",
                findings: vec![finding],
            },
        );
    }
    if json {
        let failed = sections
            .iter()
            .flat_map(|s| &s.findings)
            .any(|f| f.level == Level::Fail);
        let shown = slopmax_core::api::doctor(sections);
        println!("{}", serde_json::to_string_pretty(&shown)?);
        return Ok(i32::from(failed));
    }
    for section in sections {
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
