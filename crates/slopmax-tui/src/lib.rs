//! slopmax's terminal UI: the dashboard's pages in a terminal. Like the
//! dashboard, it is a client of the daemon's API and nothing else, so it
//! shows this machine's proxy and a hub on another machine alike.
//!
//! The report comes from the event stream, which pushes it whenever it
//! changes and each request as it is answered; a page's other answers
//! (history, a pool's forecast, the request feed, the doctor's findings,
//! settings, keys, the tailnet) are fetched when the page opens, and again
//! a few seconds after what they show has changed. Nothing polls: the only
//! timer is the clock's, once a second, for countdowns.

mod app;
mod attention;
mod data;
mod format;
mod fx;
mod terminal;
mod theme;
mod ui;

use std::future::poll_fn;
use std::pin::Pin;
use std::time::{Duration, Instant as Clock};

use crossterm::event::{Event as Input, EventStream, MouseEventKind};
use futures_core::Stream;
use slopmax_client::Client;
use tokio::sync::mpsc;

use crate::app::{App, Cmd, Modal};
use crate::data::{Msg, act, fetch, follow};
use crate::format::Now;
use crate::fx::Effects;
use crate::terminal::Screen;
use crate::theme::Theme;

/// Where the screen's data comes from, as the header and sidebar name it.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// The hub this machine uses, by name, when it uses one.
    pub hub: Option<String>,
}

/// Runs the terminal UI until it is quit, reading `client`'s daemon. The
/// terminal is given back however it ends.
pub async fn run(client: Client, options: Options) -> anyhow::Result<()> {
    // Asked before raw mode, as the question and answer pass through the
    // terminal.
    let theme = Theme::detect();
    let mut screen = Screen::take()?;
    let result = event_loop(&mut screen, client, options, &theme).await;
    drop(screen);
    result
}

async fn event_loop(
    screen: &mut Screen,
    client: Client,
    options: Options,
    theme: &Theme,
) -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    let follower = tokio::spawn(follow(client.clone(), tx.clone()));
    let mut input = EventStream::new();
    let mut clock = tokio::time::interval(Duration::from_secs(1));
    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut app = App::new(options.hub);
    let mut fx = Effects::default();
    let run = |cmds: Vec<Cmd>, screen: &mut Screen| {
        for cmd in cmds {
            match cmd {
                Cmd::Fetch(what) => fetch(&client, what, &tx),
                Cmd::Act(action) => act(&client, action, &tx),
                Cmd::Copy(text) => screen.copy(&text),
            }
        }
    };
    run(app.load(), &mut *screen);
    let mut terminated = terminated();
    // Whether anything may have changed on screen since the last frame.
    let mut changed = true;
    let result = loop {
        // A panic in a fetch has given the terminal back already.
        if terminal::panicked() {
            break Err(anyhow::anyhow!("slopmax tui stopped: a task panicked"));
        }
        // The mouse is the terminal's while a secret shows, so it can be
        // selected and copied.
        let secret = matches!(app.modal, Some(Modal::Secret { .. }));
        if let Err(e) = screen.mouse(!secret) {
            break Err(e.into());
        }
        if changed {
            fx.frame();
            let now = Now::local();
            let drawn = screen.draw(|frame| ui::draw(frame, &mut app, theme, &now, Some(&mut fx)));
            if let Err(e) = drawn {
                break Err(e.into());
            }
        }
        changed = true;
        let frame = async {
            if fx.running() {
                tokio::time::sleep(Duration::from_millis(16)).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        let cmds = tokio::select! {
            event = poll_fn(|cx| Pin::new(&mut input).poll_next(cx)) => match event {
                Some(Ok(Input::Key(key))) => app.key(key),
                // Moving the mouse changes nothing on screen.
                Some(Ok(Input::Mouse(mouse))) if mouse.kind == MouseEventKind::Moved => {
                    changed = false;
                    Vec::new()
                }
                Some(Ok(Input::Mouse(mouse))) => app.mouse(mouse),
                Some(Ok(Input::Paste(text))) => {
                    app.paste(&text);
                    Vec::new()
                }
                Some(Ok(_)) => Vec::new(),
                Some(Err(e)) => break Err(e.into()),
                None => break Ok(()),
            },
            Some(msg) = rx.recv() => {
                let mut cmds = app.apply(msg);
                // Whatever else has arrived is taken in before the next frame.
                while let Ok(msg) = rx.try_recv() {
                    cmds.extend(app.apply(msg));
                }
                cmds
            }
            _ = clock.tick() => app.tick(Clock::now()),
            () = frame => Vec::new(),
            () = &mut terminated => break Ok(()),
        };
        run(cmds, &mut *screen);
        if app.quit {
            break Ok(());
        }
        if app.suspend {
            app.suspend = false;
            if let Err(e) = screen.suspend() {
                break Err(e.into());
            }
        }
    };
    follower.abort();
    result
}

/// Ends when the process is asked to stop (SIGTERM or SIGHUP), so the
/// terminal is given back first.
fn terminated() -> Pin<Box<dyn std::future::Future<Output = ()>>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let term = signal(SignalKind::terminate());
        let hup = signal(SignalKind::hangup());
        if let (Ok(mut term), Ok(mut hup)) = (term, hup) {
            return Box::pin(async move {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = hup.recv() => {}
                }
            });
        }
    }
    Box::pin(std::future::pending())
}
