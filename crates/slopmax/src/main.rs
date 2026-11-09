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
    #[cfg(windows)]
    keep_standard_handles();
    // The proxy reports each request; other commands only warn.
    log::init(if std::env::args().nth(1).as_deref() == Some("serve") {
        Level::Info
    } else {
        Level::Warn
    });
    let runtime = match slopmax_daemon::runtime() {
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

/// Windows hands a child every inheritable handle of its parent, not only
/// the ones it is given. The CLI's own stdin, stdout and stderr are
/// inheritable, as its parent passed them down, so the proxy `start` leaves
/// running would hold them open, and whatever reads the CLI's output (a
/// script, an agent, a test) would wait for it to end until the proxy
/// stopped. A child given these handles still gets them: the standard
/// library passes each an inheritable copy.
#[cfg(windows)]
#[allow(unsafe_code)]
fn keep_standard_handles() {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};

    let handles = [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ];
    for handle in handles {
        // SAFETY: SetHandleInformation only clears a flag on the handle; on
        // a missing or invalid one it fails and changes nothing.
        unsafe {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
        }
    }
}
