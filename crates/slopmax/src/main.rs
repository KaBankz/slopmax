//! The `slopmax` command line: argument parsing, questions, and printing
//! around [`slopmax_core`], which does the work.

use std::process::ExitCode;

mod args;
mod commands;
mod term;
mod ui;

use slopmax_core::log::{self, Level};

// See the `mimalloc` feature in Cargo.toml; the platform allocator is the
// leaner default.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> ExitCode {
    // The proxy reports each request; other commands only warn.
    log::init(if std::env::args().nth(1).as_deref() == Some("serve") {
        Level::Info
    } else {
        Level::Warn
    });
    let runtime = match slopmax_core::daemon::runtime() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("{} starting: {e}", ui::red("error:"));
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(commands::run(std::env::args().skip(1))) {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(e) => {
            eprintln!("{} {e:#}", ui::red("error:"));
            ExitCode::FAILURE
        }
    }
}
