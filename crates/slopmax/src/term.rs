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

/// Asks for a line of text; an empty answer, or none, takes `default`.
pub fn ask(question: &str, default: &str) -> io::Result<String> {
    match default {
        "" => print!("{question} "),
        _ => print!("{question} {} ", ui::dim(format!("[{default}]"))),
    }
    io::stdout().flush()?;
    let answer = read_line().unwrap_or_default();
    Ok(match answer.trim() {
        "" => default.to_owned(),
        answer => answer.to_owned(),
    })
}

/// Asks for one of `options` (a name and what it means), by number; an
/// empty answer, or none, takes `default`.
pub fn choose(question: &str, options: &[(&str, &str)], default: usize) -> io::Result<usize> {
    println!("{question}");
    list(options, |i| i == default);
    // Three tries, then the default: input that has ended answers nothing.
    for _ in 0..3 {
        let answer = ask(
            &format!("  Choose 1-{}", options.len()),
            &(default + 1).to_string(),
        )?;
        match parse_choices(&answer, options.len()).as_deref() {
            Some([one]) => return Ok(*one),
            _ => println!("  {}", ui::dim("One number, please.")),
        }
    }
    Ok(default)
}

/// Asks for any of `options` by number, separated by commas or spaces; an
/// empty answer, or none, takes `defaults`.
pub fn choose_many(
    question: &str,
    options: &[(&str, &str)],
    defaults: &[usize],
) -> io::Result<Vec<usize>> {
    println!("{question}");
    list(options, |i| defaults.contains(&i));
    let default: Vec<String> = defaults.iter().map(|i| (i + 1).to_string()).collect();
    for _ in 0..3 {
        let answer = ask(
            &format!("  Numbers, e.g. 1,3 ({} for none)", ui::bold("0")),
            &default.join(","),
        )?;
        // An empty answer takes the defaults, which may be none.
        if answer.trim() == "0" || answer.trim().is_empty() {
            return Ok(Vec::new());
        }
        match parse_choices(&answer, options.len()) {
            Some(chosen) => return Ok(chosen),
            None => println!(
                "  {}",
                ui::dim(format!("Numbers from 1 to {}.", options.len()))
            ),
        }
    }
    Ok(defaults.to_vec())
}

fn list(options: &[(&str, &str)], marked: impl Fn(usize) -> bool) {
    let width = options
        .iter()
        .map(|(name, _)| name.len())
        .max()
        .unwrap_or(0);
    for (i, (name, help)) in options.iter().enumerate() {
        let mark = if marked(i) {
            ui::green("•")
        } else {
            " ".into()
        };
        println!(
            "  {mark} {} {}  {}",
            ui::dim(format!("{:>2}", i + 1)),
            ui::pad(name, width),
            ui::dim(help)
        );
    }
}

/// `"1, 3 2"` → `[0, 2, 1]`, for `len` options; `None` if any is not one.
pub(crate) fn parse_choices(answer: &str, len: usize) -> Option<Vec<usize>> {
    let mut chosen = Vec::new();
    for part in answer.split([',', ' ']).filter(|p| !p.is_empty()) {
        let n: usize = part.parse().ok()?;
        if n == 0 || n > len {
            return None;
        }
        if !chosen.contains(&(n - 1)) {
            chosen.push(n - 1);
        }
    }
    (!chosen.is_empty()).then_some(chosen)
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
    Prompt::new(show).with_pasted(pasted())
}

/// The lines typed while the receiver is held, as redirect addresses
/// pasted during a sign-in.
pub fn pasted() -> tokio::sync::mpsc::UnboundedReceiver<String> {
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
    lines_pasted
}

fn show(event: LoginEvent) {
    match event {
        LoginEvent::Authorize {
            title,
            url,
            opened,
            port,
        } => authorize(title, &url, opened, port),
        LoginEvent::DeviceCode { url, code } => device_code(&url, &code),
        LoginEvent::Notice(text) => eprintln!("  {text}"),
    }
}

/// What to do to authorize in the browser.
pub fn authorize(title: &str, url: &str, opened: bool, port: u16) {
    let verb = if opened { "Opened" } else { "Authorize" };
    eprintln!("\n  {verb} your {title} account in the browser:\n\n  {url}\n");
    if port == 0 {
        eprintln!("  Open it in any browser, then paste the code the page shows here.\n");
        return;
    }
    eprintln!(
        "  Waiting for the redirect to localhost:{port}. If the browser runs on another\n  \
         machine, paste the final localhost URL from its address bar here.\n"
    );
}

pub fn device_code(url: &str, code: &str) {
    eprintln!("\n  Open {url}\n  and enter the code: {code}\n");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choices_are_numbers_from_one() {
        assert_eq!(parse_choices("1", 3), Some(vec![0]));
        assert_eq!(parse_choices("3, 1 3", 3), Some(vec![2, 0]));
        assert_eq!(parse_choices("4", 3), None);
        assert_eq!(parse_choices("0", 3), None);
        assert_eq!(parse_choices("two", 3), None);
        assert_eq!(parse_choices(" ", 3), None);
    }
}
