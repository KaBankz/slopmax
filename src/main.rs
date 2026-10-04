use std::process::ExitCode;

use slopmax::cli;
use slopmax::log::{self, Level};
use slopmax::ui;

// See the `mimalloc` feature in Cargo.toml; the platform allocator is the
// leaner default.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> ExitCode {
    // The proxy reports each request; other commands only warn.
    log::init(if std::env::args().nth(1).as_deref() == Some("serve") {
        Level::Info
    } else {
        Level::Warn
    });

    match cli::run(std::env::args().skip(1)).await {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(e) => {
            eprintln!("{} {e:#}", ui::red("error:"));
            ExitCode::FAILURE
        }
    }
}
