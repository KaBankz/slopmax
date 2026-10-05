//! Reading from the terminal: answers, secrets, and redirect addresses
//! pasted during a sign-in. One thread reads every line typed, so a question
//! and a sign-in waiting for a paste never compete for input.

use std::io::{self, IsTerminal, Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use crate::ui;
use slopmax_core::auth::{LoginEvent, Prompt};

/// Every line typed, in order, read on one thread for the whole process.
fn lines() -> &'static Mutex<Receiver<String>> {
    static LINES: OnceLock<Mutex<Receiver<String>>> = OnceLock::new();
    LINES.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in io::stdin().lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Mutex::new(rx)
    })
}

/// The next line typed, or `None` once input ends.
fn read_line() -> Option<String> {
    lines()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .recv()
        .ok()
}

/// Asks a yes/no question; an empty answer, or none, takes `default`.
pub fn confirm(question: &str, default: bool) -> io::Result<bool> {
    let hint = if default { "[Y/n]" } else { "[y/N]" };
    print!("{question} {} ", ui::dim(hint));
    io::stdout().flush()?;
    let answer = read_line().unwrap_or_default();
    Ok(match answer.trim().to_ascii_lowercase().as_str() {
        "" => default,
        answer => matches!(answer, "y" | "yes"),
    })
}

/// Reads a secret such as an API key: typed without echo at a terminal, or
/// read whole from stdin when it is piped in, so it never sits in argv or
/// shell history.
pub fn read_secret(prompt: &str) -> io::Result<String> {
    if !io::stdin().is_terminal() {
        let mut text = String::new();
        io::stdin().lock().read_to_string(&mut text)?;
        return Ok(text.trim().to_owned());
    }
    eprint!("{prompt}: ");
    let quiet = EchoOff::new();
    let line = read_line().unwrap_or_default();
    drop(quiet);
    eprintln!();
    Ok(line.trim().to_owned())
}

/// A sign-in at the terminal: what to do goes to stderr, and the lines typed
/// while it waits are taken as pasted redirect addresses.
pub fn sign_in() -> Prompt {
    let (pasted, lines_pasted) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        // Takes lines only while the sign-in waits, checking often, so the
        // answer after it goes to whatever asks next.
        while !pasted.is_closed() {
            let next = lines()
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .recv_timeout(Duration::from_millis(100));
            match next {
                Ok(line) => {
                    let _ = pasted.send(line);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Prompt::new(show).with_pasted(lines_pasted)
}

fn show(event: LoginEvent) {
    match event {
        LoginEvent::Authorize {
            title,
            url,
            opened,
            port,
        } => {
            let verb = if opened { "Opened" } else { "Authorize" };
            eprintln!("\n  {verb} your {title} account in the browser:\n\n  {url}\n");
            eprintln!(
                "  Waiting for the redirect to localhost:{port}. If the browser runs on another\n  \
                 machine, paste the final localhost URL from its address bar here.\n"
            );
        }
        LoginEvent::DeviceCode { url, code } => {
            eprintln!("\n  Open {url}\n  and enter the code: {code}\n");
        }
        LoginEvent::Notice(text) => eprintln!("  {text}"),
    }
}

/// Turns off terminal echo until dropped.
struct EchoOff {
    #[cfg(unix)]
    saved: Option<libc::termios>,
}

#[allow(unsafe_code)]
impl EchoOff {
    #[cfg(unix)]
    fn new() -> Self {
        // SAFETY: tcgetattr and tcsetattr only read and write the termios
        // they are given, which lives on this stack frame.
        unsafe {
            let mut term: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut term) != 0 {
                return Self { saved: None };
            }
            let saved = term;
            term.c_lflag &= !libc::ECHO;
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &term) != 0 {
                return Self { saved: None };
            }
            Self { saved: Some(saved) }
        }
    }

    #[cfg(not(unix))]
    fn new() -> Self {
        Self {}
    }
}

#[allow(unsafe_code)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(saved) = &self.saved {
            // SAFETY: as in `new`.
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, saved);
            }
        }
    }
}
