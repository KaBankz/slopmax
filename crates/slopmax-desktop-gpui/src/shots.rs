//! Draws each page of the window, and the menu bar panel, to images in
//! light and dark, without a screen: for reviewing the design while the
//! screen is locked or asleep, when nothing on it draws. Built with
//! `--features shots` and run with `SLOPMAX_SHOTS` naming a directory, the
//! app draws its pages there once its accounts have loaded, then quits.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui_kit::*;
use slopmax_app::view;
use slopmax_core::provider::ProviderId;
use slopmax_core::time::Timestamp;

use crate::prefs::{Appearance, Prefs};
use crate::{Main, Section, Shared, panel, theme};

/// The window in the images: its usual width, tall enough for most pages
/// whole.
const SIZE: (f32, f32) = (1160., 1400.);

/// Draws the pages, if `SLOPMAX_SHOTS` names where.
pub(crate) fn start(cx: &mut App) {
    let Some(dir) = std::env::var_os("SLOPMAX_SHOTS").map(PathBuf::from) else {
        return;
    };
    // Each page as it settles, rather than partway into how it appears.
    cx.set_reduce_motion(true);
    cx.spawn(async move |cx: &mut AsyncApp| {
        if let Err(e) = shoot(&dir, cx).await {
            eprintln!("slopmax: could not draw the pages: {e:#}");
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

async fn shoot(dir: &Path, cx: &mut AsyncApp) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let (window, main) = cx.update(|cx| {
        let shared = cx.global::<Shared>();
        (shared.window, shared.main.clone())
    });
    let (Some(window), Some(main)) = (window, main) else {
        anyhow::bail!("the window did not open");
    };
    window.update(cx, |_, window, _| {
        window.resize(size(px(SIZE.0), px(SIZE.1)));
    })?;
    wait(cx, &main, |main| {
        main.snapshot.report.is_some() && main.snapshot.today.is_some()
    })
    .await?;
    for appearance in [Appearance::Light, Appearance::Dark] {
        // Not saved: the choice in Settings stays as it was.
        cx.update(|cx| {
            cx.global_mut::<Prefs>().appearance = appearance;
            theme::refresh(cx);
        });
        let mode = appearance.title().to_lowercase();
        // The pages the sidebar lists, each named for its title.
        let sections = main.read_with(cx, |main, _| main.sections(Timestamp::now()))?;
        for section in sections {
            let name = section.title().to_lowercase().replace(' ', "-");
            main.update(cx, |main, cx| {
                main.go(section, cx);
                if let Section::Provider(provider) = section {
                    open_credits(main, provider);
                }
            })?;
            if matches!(section, Section::Usage | Section::Performance) {
                wait(cx, &main, |main| main.snapshot.history.is_some()).await?;
            }
            capture(window, &dir.join(format!("{mode}-{name}.png")), cx).await?;
        }
        cx.update(panel::toggle);
        let opened = cx.update(|cx| cx.global::<Shared>().panel);
        if let Some(panel) = opened {
            capture(panel, &dir.join(format!("{mode}-panel.png")), cx).await?;
        }
        cx.update(panel::dismiss);
    }
    Ok(())
}

/// Waits until `ready` holds for the window's state, for up to 20 seconds.
async fn wait(
    cx: &mut AsyncApp,
    main: &WeakEntity<Main>,
    ready: impl Fn(&Main) -> bool,
) -> anyhow::Result<()> {
    for _ in 0..200 {
        if main.read_with(cx, |main, _| ready(main))? {
            return Ok(());
        }
        cx.background_executor()
            .timer(Duration::from_millis(100))
            .await;
    }
    anyhow::bail!("what the page shows did not load")
}

/// Opens the first account's reset credits on `provider`'s page.
fn open_credits(main: &mut Main, provider: ProviderId) {
    let Some(report) = &main.snapshot.report else {
        return;
    };
    let groups = view::groups(report, Timestamp::now());
    if let Some(row) = groups
        .iter()
        .filter(|group| group.provider == provider)
        .flat_map(|group| &group.accounts)
        .find(|row| row.credits.is_some())
    {
        main.credits_open.insert(row.id.clone());
    }
}

/// Draws `window` and saves what it shows to `path`.
async fn capture(window: AnyWindowHandle, path: &Path, cx: &mut AsyncApp) -> anyhow::Result<()> {
    // A frame lays out what the next one sizes by, as the panel fits its
    // height to what it holds.
    for _ in 0..2 {
        window.update(cx, |_, window, cx| {
            settle(window, cx);
            window.draw(cx).clear(cx);
        })?;
        cx.background_executor()
            .timer(Duration::from_millis(150))
            .await;
    }
    let image = window.update(cx, |_, window, cx| {
        settle(window, cx);
        window.draw(cx).clear(cx);
        window.render_to_image()
    })??;
    image.save(path)?;
    println!("{}", path.display());
    Ok(())
}

/// Readies `window` for a frame: it takes up its size as it stands, as a
/// resize made while a frame draws reaches it only with the next frame on
/// screen, and the pointer leaves it, so nothing shows as hovered wherever
/// the pointer rests on the screen.
fn settle(window: &mut Window, cx: &mut App) {
    window.bounds_changed(cx);
    let _ = window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: point(px(-100.), px(-100.)),
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
}
