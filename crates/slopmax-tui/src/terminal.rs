//! Taking the terminal over, and always giving it back: on quitting, on an
//! error, on a panic, and around a suspend. Every frame is drawn inside a
//! synchronized update, so a terminal that supports one never shows half a
//! frame.

use std::io::{self, Stdout, Write};
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{
    self, BeginSynchronizedUpdate, EndSynchronizedUpdate, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, execute, queue};
use ratatui::backend::CrosstermBackend;
use ratatui::{Frame, Terminal};

/// Whether the terminal is ours now, so it is given back once.
static TAKEN: AtomicBool = AtomicBool::new(false);
/// Whether keys are reported with the Kitty protocol's flags, which are
/// popped on the way out.
static KEYBOARD: AtomicBool = AtomicBool::new(false);
/// Whether something panicked, on any thread: the terminal is given back
/// then, and nothing more is drawn.
static PANICKED: AtomicBool = AtomicBool::new(false);

/// Whether a panic has given the terminal back.
pub fn panicked() -> bool {
    PANICKED.load(Ordering::SeqCst)
}

pub struct Screen {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    /// Whether the mouse is reported to slopmax rather than the terminal.
    mouse: bool,
    /// Whether the terminal takes the Kitty protocol's flags. Asked once,
    /// on taking the terminal: asking again after a suspend would race the
    /// input stream, which reads the same terminal, for the answer.
    #[cfg_attr(not(unix), allow(dead_code))]
    keyboard: bool,
}

impl Screen {
    pub fn take() -> io::Result<Self> {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                PANICKED.store(true, Ordering::SeqCst);
                give_back();
                previous(info);
            }));
        });
        enter()?;
        // Nothing reads input yet, so the answer can't be taken by anyone
        // else.
        let keyboard = matches!(terminal::supports_keyboard_enhancement(), Ok(true));
        if keyboard {
            push_keyboard();
        }
        match Terminal::new(CrosstermBackend::new(io::stdout())) {
            Ok(terminal) => Ok(Self {
                terminal,
                mouse: true,
                keyboard,
            }),
            Err(e) => {
                give_back();
                Err(e)
            }
        }
    }

    /// Draws a frame between the markers of a synchronized update; the
    /// closing one is sent even when drawing fails.
    pub fn draw(&mut self, render: impl FnOnce(&mut Frame<'_>)) -> io::Result<()> {
        if panicked() {
            return Err(io::Error::other(
                "the terminal was given back after a panic",
            ));
        }
        queue!(self.terminal.backend_mut(), BeginSynchronizedUpdate)?;
        let drawn = self.terminal.draw(render).map(drop);
        let ended = execute!(self.terminal.backend_mut(), EndSynchronizedUpdate);
        drawn.and(ended)
    }

    /// Reports the mouse to slopmax, or leaves it to the terminal, where
    /// text can be selected.
    pub fn mouse(&mut self, on: bool) -> io::Result<()> {
        if on == self.mouse {
            return Ok(());
        }
        self.mouse = on;
        let out = self.terminal.backend_mut();
        if on {
            execute!(out, EnableMouseCapture)
        } else {
            execute!(out, DisableMouseCapture)
        }
    }

    /// Asks the terminal to put `text` on the clipboard (OSC 52). A
    /// terminal that doesn't take it ignores it.
    pub fn copy(&mut self, text: &str) {
        let out = self.terminal.backend_mut();
        let _ = write!(out, "\x1b]52;c;{}\x07", base64(text.as_bytes()));
        let _ = out.flush();
    }

    /// Gives the terminal back and stops, as Ctrl-Z does in a shell; takes
    /// it again and draws everything anew once the shell resumes it.
    #[cfg(unix)]
    pub fn suspend(&mut self) -> io::Result<()> {
        give_back();
        // The shell's job control stops slopmax here, and `fg` continues it.
        let _ = signal_hook::low_level::raise(signal_hook::consts::SIGTSTP);
        enter()?;
        if self.keyboard {
            push_keyboard();
        }
        if !self.mouse {
            execute!(self.terminal.backend_mut(), DisableMouseCapture)?;
        }
        self.terminal.clear()
    }

    #[cfg(not(unix))]
    pub fn suspend(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        give_back();
    }
}

fn enter() -> io::Result<()> {
    terminal::enable_raw_mode()?;
    TAKEN.store(true, Ordering::SeqCst);
    let mut out = io::stdout();
    let entered = execute!(
        out,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste,
        cursor::Hide
    );
    if let Err(e) = entered {
        give_back();
        return Err(e);
    }
    Ok(())
}

/// Has keys reported with the Kitty protocol's flags, so Esc comes at once
/// and keys with modifiers are told apart; they are popped on the way out.
fn push_keyboard() {
    let pushed = execute!(
        io::stdout(),
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    );
    if pushed.is_ok() {
        KEYBOARD.store(true, Ordering::SeqCst);
    }
}

/// Puts the terminal back as it was. Safe to call more than once, and from
/// the panic hook.
pub fn give_back() {
    if !TAKEN.swap(false, Ordering::SeqCst) {
        return;
    }
    let mut out = io::stdout();
    if KEYBOARD.swap(false, Ordering::SeqCst) {
        let _ = execute!(out, PopKeyboardEnhancementFlags);
    }
    let _ = execute!(
        out,
        EndSynchronizedUpdate,
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen,
        cursor::Show
    );
    let _ = terminal::disable_raw_mode();
}

/// `bytes` in standard base64, as OSC 52 takes them.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_pads_to_whole_quads() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"sk-slopmax"), "c2stc2xvcG1heA==");
    }
}
