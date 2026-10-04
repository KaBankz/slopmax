use std::process::ExitCode;

use clap::Parser;
use slopmax::cli::{self, Cli};
use slopmax::ui;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    slopmax::init();
    let cli = Cli::parse();
    let default_level = if std::env::args().nth(1).as_deref() == Some("serve") {
        "slopmax=info"
    } else {
        "slopmax=warn"
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("SLOPMAX_LOG")
                .unwrap_or_else(|_| EnvFilter::new(default_level)),
        )
        .with_writer(std::io::stderr)
        .init();

    match cli::run(cli).await {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(e) => {
            eprintln!("{} {e:#}", ui::red("error:"));
            ExitCode::FAILURE
        }
    }
}
