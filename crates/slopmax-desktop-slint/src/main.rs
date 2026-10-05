//! The slopmax desktop app drawn with Slint: a window over slopmax-app's
//! snapshot, and a menu bar icon showing each pool's use.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use slint::{ComponentHandle, Model, ModelRc, SharedString, Timer, TimerMode, VecModel};
use slopmax_app::view::{self, SignInView};
use slopmax_app::{App, Proxy, Snapshot};
use slopmax_core::provider::ProviderId;
use slopmax_core::report;
use slopmax_core::time::Timestamp;

slint::include_modules!();

/// The window's lists, kept from one redraw to the next and changed in
/// place, so rows keep their elements: focus, hover, and what a screen
/// reader is on stay put while the numbers move.
#[derive(Default)]
struct Lists {
    groups: Rc<VecModel<Group>>,
    rows: RefCell<Vec<Rc<VecModel<Row>>>>,
    agents: Rc<VecModel<Agent>>,
}

thread_local! {
    static LISTS: Lists = Lists::default();
}

fn main() -> Result<()> {
    let app = Arc::new(App::start()?);
    let window = AppWindow::new()?;
    let tray = Tray::new()?;
    LISTS.with(|lists| {
        window.set_groups(ModelRc::from(lists.groups.clone()));
        window.set_agents(ModelRc::from(lists.agents.clone()));
    });
    wire(&window, &tray, &app);

    // Each change to the snapshot is drawn on the UI thread.
    let mut changes = app.subscribe();
    let (window_handle, tray_handle) = (window.as_weak(), tray.as_weak());
    app.handle().spawn(async move {
        loop {
            let snapshot = changes.borrow_and_update().clone();
            let (window, tray) = (window_handle.clone(), tray_handle.clone());
            let drawn = slint::invoke_from_event_loop(move || {
                if let (Some(window), Some(tray)) = (window.upgrade(), tray.upgrade()) {
                    draw(&window, &tray, &snapshot);
                }
            });
            if drawn.is_err() || changes.changed().await.is_err() {
                break;
            }
        }
    });
    // Countdowns move every second.
    let ticker = Timer::default();
    let (window_handle, tray_handle, latest) = (window.as_weak(), tray.as_weak(), app.clone());
    ticker.start(TimerMode::Repeated, Duration::from_secs(1), move || {
        if let (Some(window), Some(tray)) = (window_handle.upgrade(), tray_handle.upgrade()) {
            draw(&window, &tray, &latest.snapshot());
        }
    });

    window.show()?;
    tray.show()?;
    // Closing the window leaves the menu bar icon, whose Quit ends the app.
    slint::run_event_loop_until_quit()?;
    Ok(())
}

/// Connects every button to the app's action of the same name.
fn wire(window: &AppWindow, tray: &Tray, app: &Arc<App>) {
    let on = |app: &Arc<App>| app.clone();
    window.on_sign_in({
        let app = on(app);
        move |provider| {
            if let Ok(provider) = provider.parse::<ProviderId>() {
                app.sign_in(provider);
            }
        }
    });
    window.on_add_key({
        let app = on(app);
        move |provider, key| {
            if let Ok(provider) = provider.parse::<ProviderId>() {
                app.add_key(provider, key.into());
            }
        }
    });
    window.on_paste({
        let app = on(app);
        move |address| app.paste(address.into())
    });
    window.on_cancel_sign_in({
        let app = on(app);
        move || app.cancel_sign_in()
    });
    window.on_import({
        let app = on(app);
        move || app.import()
    });
    window.on_pin({
        let app = on(app);
        move |id| app.pin(&id)
    });
    window.on_unpin_all({
        let app = on(app);
        move || app.unpin_all()
    });
    window.on_set_disabled({
        let app = on(app);
        move |id, disabled| app.set_disabled(&id, disabled)
    });
    window.on_connect_agent({
        let app = on(app);
        move |id| app.connect_agent(&id)
    });
    window.on_disconnect_agent({
        let app = on(app);
        move |id| app.disconnect_agent(&id)
    });
    window.on_start_proxy({
        let app = on(app);
        move || app.start_proxy()
    });
    window.on_stop_proxy({
        let app = on(app);
        move || app.stop_proxy()
    });
    window.on_install_service({
        let app = on(app);
        move || app.install_service()
    });
    window.on_refresh({
        let app = on(app);
        move || app.refresh()
    });
    window.on_open_dashboard({
        let app = on(app);
        move || app.open_dashboard()
    });
    window.on_dismiss_notice({
        let app = on(app);
        move || app.dismiss_notice()
    });

    tray.on_open_window({
        let window = window.as_weak();
        move || {
            if let Some(window) = window.upgrade() {
                let _ = window.show();
            }
        }
    });
    tray.on_refresh({
        let app = on(app);
        move || app.refresh()
    });
    tray.on_quit(|| {
        let _ = slint::quit_event_loop();
    });
}

fn draw(window: &AppWindow, tray: &Tray, snapshot: &Snapshot) {
    let now = Timestamp::now();
    window.set_proxy_running(matches!(snapshot.proxy, Proxy::Running { .. }));
    window.set_proxy_state(view::proxy_line(snapshot).into());
    window.set_address(snapshot.address.clone().into());

    let groups = snapshot
        .report
        .as_ref()
        .map(|report| view::groups(report, now))
        .unwrap_or_default();
    window.set_has_accounts(!groups.is_empty());
    LISTS.with(|lists| {
        let mut rows = lists.rows.borrow_mut();
        rows.resize_with(groups.len(), Rc::default);
        let drawn = groups
            .iter()
            .zip(rows.iter())
            .map(|(view, model)| {
                update_rows(model, view.accounts.iter().map(row).collect());
                group(view, ModelRc::from(model.clone()))
            })
            .collect();
        update(&lists.groups, drawn);
        let agents = snapshot.agents.iter().map(|agent| {
            let (state, connected) = view::agent_line(agent);
            Agent {
                id: agent.id.into(),
                title: agent.title.into(),
                state: state.into(),
                connected,
            }
        });
        update(&lists.agents, agents.collect());
    });
    let (service, can_install) = view::service_line(snapshot.service.as_ref());
    window.set_service_state(service.into());
    window.set_can_install_service(can_install);

    match &snapshot.notice {
        Some(notice) => {
            window.set_notice(notice.text.clone().into());
            window.set_notice_error(notice.error);
        }
        None => window.set_notice(SharedString::new()),
    }
    let sign_in = snapshot.sign_in.as_ref().map(view::sign_in);
    window.set_signing_in(sign_in.is_some());
    if let Some(SignInView {
        title,
        detail,
        link,
        code,
        notes,
    }) = sign_in
    {
        window.set_sign_in_title(title.to_uppercase().into());
        window.set_sign_in_detail(detail.into());
        window.set_sign_in_link(link.unwrap_or_default().into());
        window.set_sign_in_code(code.unwrap_or_default().into());
        window.set_sign_in_notes(notes.into());
    }

    let line = match &snapshot.report {
        Some(report) => view::menu_bar(report, now),
        None => "slopmax".to_owned(),
    };
    tray.set_line(line.into());
}

fn group(group: &view::Group, rows: ModelRc<Row>) -> Group {
    let pool = group.pool.as_ref();
    Group {
        title: group.title.to_uppercase().into(),
        subscription: group.subscription,
        rows,
        pooled: pool.is_some(),
        pool_accounts: pool.map_or(0, |p| p.accounts as i32),
        pool_five_hour: gauge(pool.and_then(|p| p.five_hour.as_ref())),
        pool_week: gauge(pool.and_then(|p| p.week.as_ref())),
    }
}

fn row(row: &view::Row) -> Row {
    Row {
        id: row.id.clone().into(),
        name: row.name.clone().into(),
        plan: row.plan.clone().into(),
        five_hour: gauge(row.five_hour.as_ref()),
        week: gauge(row.week.as_ref()),
        status: label(&row.status),
        notes: model(row.notes.iter().map(label)),
        pinned: row.pinned,
        disabled: row.disabled,
    }
}

fn gauge(gauge: Option<&view::Gauge>) -> Gauge {
    match gauge {
        Some(g) => Gauge {
            present: true,
            fraction: g.fraction,
            percent: g.percent.clone().into(),
            resets: g.resets_in.clone().unwrap_or_default().into(),
            tone: tone(g.tone),
        },
        None => Gauge::default(),
    }
}

fn label(label: &view::Label) -> Label {
    Label {
        text: label.text.clone().into(),
        tone: tone(label.tone),
    }
}

fn tone(tone: report::Tone) -> Tone {
    match tone {
        report::Tone::Good => Tone::Good,
        report::Tone::Muted => Tone::Muted,
        report::Tone::Accent => Tone::Accent,
        report::Tone::Warn => Tone::Warn,
        report::Tone::Bad => Tone::Bad,
    }
}

fn model<T: Clone + 'static>(items: impl Iterator<Item = T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(items.collect::<Vec<T>>()))
}

/// Makes `model` hold `items`, touching only the rows that changed.
fn update<T: Clone + PartialEq + 'static>(model: &VecModel<T>, items: Vec<T>) {
    for (i, item) in items.iter().enumerate() {
        match model.row_data(i) {
            Some(old) if old == *item => {}
            Some(_) => model.set_row_data(i, item.clone()),
            None => model.push(item.clone()),
        }
    }
    while model.row_count() > items.len() {
        model.remove(model.row_count() - 1);
    }
}

/// [`update`] for account rows, keeping a row's notes model while its notes
/// read the same, so an unchanged row compares equal.
fn update_rows(model: &VecModel<Row>, rows: Vec<Row>) {
    let rows = rows
        .into_iter()
        .enumerate()
        .map(|(i, mut row)| {
            if let Some(old) = model.row_data(i)
                && old.notes.iter().eq(row.notes.iter())
            {
                row.notes = old.notes;
            }
            row
        })
        .collect();
    update(model, rows);
}
