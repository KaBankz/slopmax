//! Taking the terminal over, and always giving it back: on quitting, on an
//! error, on a panic, and around a suspend. Every frame is drawn inside a
//! synchronized update, so a terminal that supports one never shows half a
//! frame.

use std::io::{self, Stdout};
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

pub struct Screen {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl Screen {
    pub fn take() -> io::Result<Self> {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                give_back();
                previous(info);
            }));
        });
        enter()?;
        match Terminal::new(CrosstermBackend::new(io::stdout())) {
            Ok(terminal) => Ok(Self { terminal }),
            Err(e) => {
                give_back();
                Err(e)
            }
        }
    }

    /// Draws a frame between the markers of a synchronized update; the
    /// closing one is sent even when drawing fails.
    pub fn draw(&mut self, render: impl FnOnce(&mut Frame<'_>)) -> io::Result<()> {
        queue!(self.terminal.backend_mut(), BeginSynchronizedUpdate)?;
        let drawn = self.terminal.draw(render).map(drop);
        let ended = execute!(self.terminal.backend_mut(), EndSynchronizedUpdate);
        drawn.and(ended)
    }

    /// Gives the terminal back and stops, as Ctrl-Z does in a shell; takes
    /// it again and draws everything anew once the shell resumes it.
    #[cfg(unix)]
    pub fn suspend(&mut self) -> io::Result<()> {
        give_back();
        // The shell's job control stops slopmax here, and `fg` continues it.
        let _ = std::process::Command::new("kill")
            .args(["-TSTP", &std::process::id().to_string()])
            .status();
        enter()?;
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
    if matches!(terminal::supports_keyboard_enhancement(), Ok(true))
        && execute!(
            out,
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )
        .is_ok()
    {
        KEYBOARD.store(true, Ordering::SeqCst);
    }
    Ok(())
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
