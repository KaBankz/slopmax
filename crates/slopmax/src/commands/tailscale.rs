//! `slopmax tailscale`: publishing slopmax to the user's own tailnet with
//! `tailscale serve`, and who there uses it without a key. The proxy
//! still listens on 127.0.0.1; Tailscale passes requests on to its
//! owner-only socket, which tells slopmax who is asking.
//!
//! slopmax never runs `sudo`, `tailscale set`, `up`, `down`, `funnel` or
//! `serve reset`: what needs them is said, for the user to run.

use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use slopmax_client::api::ApiError;
use slopmax_client::api::tailnet::{self as api, TailnetPatch};

use super::home;
use crate::ui;
use slopmax_core::config::{AdminMachine, Config, TAILNET_TOKEN, Tailnet};
use slopmax_core::tailscale::{self, BackendState, Node, Peer, Port, Tailscale, Target, TsError};

/// What `slopmax tailscale` was given.
pub struct Args<'a> {
    /// `status`, `on`, `off`, `users`, or `admins`.
    pub action: &'a str,
    /// With `users` or `admins`: `list`, `add`, or `remove`.
    pub op: &'a str,
    /// With `users` or `admins`: the logins or machines, comma-separated.
    pub name: &'a str,
    pub port: Option<u16>,
    pub users: Vec<&'a str>,
    pub admins: Vec<&'a str>,
    pub loopback: bool,
    pub socket: bool,
    pub json: bool,
}

pub async fn run(config: &Config, args: Args<'_>) -> Result<()> {
    if let Some(url) = config.hub_url() {
        let url = url.trim_end_matches('/');
        if args.action == "status" && args.json {
            let hub = serde_json::json!({ "hub": url });
            println!("{}", serde_json::to_string_pretty(&hub)?);
            return Ok(());
        }
        if args.action == "status" {
            println!("This machine uses the hub at {url}.");
            return Ok(());
        }
        bail!(config.hub_refusal().unwrap_or_default());
    }
    match args.action {
        "on" => on(config, &args).await,
        "off" => off(config).await,
        "users" => users(config, args.op, args.name).await,
        "admins" => admins(config, args.op, args.name).await,
        _ => status(config, args.json).await,
    }
}

/// Where Tailscale may send requests for this home's slopmax: its socket,
/// a private path on its port, or its port.
pub fn targets(config: &Config) -> [Target; 3] {
    tailscale::targets(home(), config)
}

/// A Tailscale error as the CLI reports it: what went wrong, then on the
/// next line what fixes it.
pub fn fail(e: TsError) -> anyhow::Error {
    match e.fix() {
        Some(fix) => anyhow!("{}\n{fix}", e.message()),
        None => anyhow!("{}", e.message()),
    }
}

/// Only root may change what this machine serves: how to change that, or
/// do it by hand.
fn access_denied(again: &str, by_hand: &str) -> anyhow::Error {
    anyhow!(
        "{}\nRun this once, then `slopmax tailscale {again}` again:\n  sudo tailscale set \
         --operator=$USER\nOr do it yourself: sudo {by_hand}\n(slopmax never runs sudo itself.)",
        TsError::AccessDenied.message()
    )
}

/// Only root may publish the socket: the one command that does it, or the
/// private path, which needs no root once the user is Tailscale's operator.
fn root_only(again: &str, by_hand: &str) -> anyhow::Error {
    anyhow!(
        "{}\nPublish it once yourself, then run `slopmax tailscale {again}` again:\n  sudo \
         {by_hand}\nOr leave out --socket: `slopmax tailscale on` publishes a private path on \
         the proxy's port, which needs no root.\n(slopmax never runs sudo itself.)",
        TsError::RootOnly.message()
    )
}

/// The longest socket path slopmax listens on: macOS takes 104 bytes.
const SOCKET_PATH_MAX: usize = 100;

/// Which way Tailscale should reach slopmax here: a private path on the
/// proxy's port, which Tailscale's operator may publish and which tells
/// slopmax who is asking; the socket, which only root may publish; or the
/// bare port, where every machine needs a key.
fn transport(config: &Config, args: &Args<'_>) -> Result<Target> {
    let [socket, private, loopback] = targets(config);
    if args.loopback {
        return Ok(loopback);
    }
    if !args.socket {
        return Ok(private);
    }
    if !cfg!(unix) {
        bail!("Windows has no socket for Tailscale to reach slopmax through; leave out --socket");
    }
    if home().tailnet_socket().as_os_str().len() > SOCKET_PATH_MAX {
        bail!(
            "{} is too long a path for a socket; move SLOPMAX_HOME somewhere shorter, or leave \
             out --socket",
            home().tailnet_socket().display()
        );
    }
    Ok(socket)
}

/// `slopmax tailscale on`.
async fn on(config: &Config, args: &Args<'_>) -> Result<()> {
    if args.loopback && args.socket {
        bail!("--loopback and --socket are opposite ways to publish slopmax; give one");
    }
    let ts = Tailscale::find().map_err(fail)?;
    let node = ts.node().await.map_err(fail)?;
    if let Some(e) = tailscale::state_error(&node) {
        return Err(fail(e));
    }
    if node.backend_state != BackendState::Running {
        bail!("Tailscale here is still starting; run `slopmax tailscale on` again in a moment");
    }
    if node.cert_domains.is_empty() {
        return Err(fail(TsError::NoHttps));
    }
    let port = args.port.unwrap_or(config.listen.port());
    let serve = ts.serve_state().await.map_err(fail)?;
    // slopmax at a private path made from an older owner key: replaced.
    let older = |h: &tailscale::Handler| {
        h.port == port && tailscale::older_private(h, config.listen.port())
    };
    let taken = match tailscale::port_use(&serve, port, &targets(config)) {
        Port::Taken { .. }
            if serve
                .handlers
                .iter()
                .filter(|h| h.port == port)
                .all(|h| older(h) || tailscale::ours(h, &targets(config))) =>
        {
            None
        }
        Port::Taken { by } => Some(by),
        _ => None,
    };
    if let Some(by) = taken {
        let e = TsError::PortTaken { port, by };
        if !tailscale::stale(&serve, port, &targets(config)).is_empty() {
            // Something on this machine, perhaps slopmax from another home
            // or port, which is turned off by hand: slopmax turns off only
            // what serves this home.
            bail!(
                "{}\n{}\nIf that is slopmax from before, turn it off first: {}",
                e.message(),
                e.fix().unwrap_or_default(),
                tailscale::serve_off(port)
            );
        }
        return Err(fail(e));
    }
    if serve.funnel_ports.contains(&port) {
        return Err(fail(TsError::Funnel { port }));
    }
    let mut target = transport(config, args)?;
    let mut why: Option<String> = None;
    let by_hand =
        |target: &Target| format!("tailscale serve --bg --yes --https={port} {}", target.arg());
    let mut again = "on".to_owned();
    if let Some(port) = args.port {
        again.push_str(&format!(" --port {port}"));
    }
    if args.socket {
        again.push_str(" --socket");
    } else if args.loopback {
        again.push_str(" --loopback");
    }
    // Published already, perhaps by hand with sudo: nothing for Tailscale
    // to change, so nothing that needs root.
    let published = matches!(
        tailscale::port_use(&serve, port, &targets(config)),
        Port::Ours(handler) if tailscale::ours(&handler, std::slice::from_ref(&target))
    );
    if !published && cfg!(target_os = "linux") && !tailscale::is_root() {
        let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
        let operator = ts.operator().await;
        if operator.is_none() || (user.is_some() && operator != user) {
            // The operator may publish the proxy's port, but not a socket.
            return Err(match target {
                Target::Socket(_) => root_only(&again, &by_hand(&target)),
                Target::Private { .. } | Target::Loopback(_) => {
                    access_denied(&again, &by_hand(&target))
                }
            });
        }
    }

    let mut tailnet = config.tailscale.clone().unwrap_or_default();
    let tagged = !node.tags.is_empty();
    // An untagged hub lets its own login in first; `--user` adds more.
    if tailnet.users.is_empty()
        && !tagged
        && let Some(login) = &node.login
    {
        tailnet.users.push(login.clone());
    }
    for user in &args.users {
        add_user(&mut tailnet.users, user)?;
    }
    if !args.admins.is_empty() {
        let (here, peers) = ts.peers().await.map_err(fail)?;
        for machine in &args.admins {
            add_admin(
                &mut tailnet.admins,
                admin_of(&here, &peers, machine, &tailnet.users)?,
            );
        }
    }
    if config.tailscale.as_ref() != Some(&tailnet) {
        save(config, &tailnet).await?;
    }

    super::background::ensure_running(config).await?;
    if let Target::Socket(path) = &target
        && !slopmax_core::doctor::socket_answers(path, Duration::from_secs(3)).await
    {
        bail!(
            "the proxy isn't listening on {}; restart it: slopmax stop && slopmax start",
            path.display()
        );
    }
    if !published {
        publish(&ts, port, &target, &again, &by_hand).await?;
    }
    let mut url = check_published(&ts, &node, port, &target).await?;
    let mut note = None;
    match reach(&url).await {
        Reached::Tailnet => {}
        Reached::Status(502)
            if cfg!(target_os = "macos") && matches!(target, Target::Socket(_)) =>
        {
            // Tailscale here can't open the socket: the private path on
            // the proxy's port instead, which names the caller too.
            ts.unpublish(port).await.map_err(fail)?;
            let [_, private, _] = targets(config);
            target = private;
            publish(&ts, port, &target, &again, &by_hand).await?;
            url = check_published(&ts, &node, port, &target).await?;
            why = Some(
                "Tailscale here couldn't reach slopmax's socket, so it serves a private path on \
                 the proxy's port instead."
                    .into(),
            );
        }
        // Over the proxy's port, slopmax can't tell that the tailnet
        // asked, but it answered.
        Reached::Elsewhere if matches!(target, Target::Loopback(_)) => {}
        _ => {
            note = Some(format!(
                "couldn't check the address from this machine; check it from another: {}",
                setup_command(&node.name, &url, port)
            ));
        }
    }

    let who = match &node.login {
        Some(login) => format!("signed in as {login}"),
        None => format!("tagged {}", node.tags.join(", ")),
    };
    println!("Tailscale is running here: {}, {who}.", node.name);
    println!("Your machines reach slopmax at {}", ui::bold(&url));
    let users = &tailnet.users;
    match (&target, users.is_empty()) {
        (Target::Socket(_) | Target::Private { .. }, false) => {
            println!(
                "  Machines signed in as {} use it without a key and see its status read-only.",
                users.join(" or ")
            );
            println!("  To let a machine manage it too: slopmax tailscale admins add <machine>");
            println!("  Tagged machines need a key: slopmax key add <name>");
        }
        (Target::Socket(_) | Target::Private { .. }, true) => {
            println!(
                "  This machine is tagged, so no login is let in without a key: every machine \
                 needs one (slopmax key add <name>)."
            );
            println!(
                "  `slopmax tailscale users add <login>` lets your own machines in without one."
            );
        }
        (Target::Loopback(_), _) => {
            if let Some(why) = &why {
                println!("  {why}");
            }
            println!(
                "  Tailscale here can't tell slopmax who is asking, so every machine needs a key: \
                 slopmax key add <name>"
            );
        }
    }
    println!(
        "On another machine: {}",
        setup_command(&node.name, &url, port)
    );
    println!("Dashboard from your phone or laptop: {url}/slopmax/");
    if let Some(note) = note {
        println!("{}", ui::dim(note));
    }
    Ok(())
}

/// The command that points another machine at this hub: by the hub's
/// name, which `setup --hub` looks up on the usual port, else by its whole
/// address.
fn setup_command(name: &str, url: &str, port: u16) -> String {
    if port == super::remote::HUB_PORT && !name.is_empty() {
        format!("slopmax setup --hub {name}")
    } else {
        format!("slopmax setup --hub {url}")
    }
}

/// Publishes `target` on `port`, a refusal said as how to get the right,
/// then `slopmax tailscale {again}`.
async fn publish(
    ts: &Tailscale,
    port: u16,
    target: &Target,
    again: &str,
    by_hand: &dyn Fn(&Target) -> String,
) -> Result<()> {
    match ts.publish(port, target).await {
        Ok(()) => Ok(()),
        Err(TsError::AccessDenied) => Err(access_denied(again, &by_hand(target))),
        Err(TsError::RootOnly) => Err(root_only(again, &by_hand(target))),
        Err(e) => Err(fail(e)),
    }
}

/// Reads back what Tailscale now serves on `port`, which must be slopmax
/// at `target`, and returns its address.
async fn check_published(
    ts: &Tailscale,
    node: &Node,
    port: u16,
    target: &Target,
) -> Result<String> {
    let serve = ts.serve_state().await.map_err(fail)?;
    let ours = std::slice::from_ref(target);
    if !matches!(tailscale::port_use(&serve, port, ours), Port::Ours(_)) {
        bail!(
            "Tailscale didn't keep slopmax on port {port}; `tailscale serve status` shows what \
             it serves"
        );
    }
    Ok(tailscale::published(&serve, node, ours)
        .into_iter()
        .find(|p| p.port == port)
        .map_or_else(|| format!("https://{}:{port}", node.dns_name), |p| p.url))
}

/// How slopmax's address on the tailnet answered from this machine.
enum Reached {
    /// slopmax, knowing the request came over the tailnet.
    Tailnet,
    /// slopmax, but not by the tailnet: Tailscale passed it on another way.
    Elsewhere,
    /// An HTTP error.
    Status(u16),
    /// No answer.
    Failed,
}

/// Asks slopmax's address on the tailnet for `/healthz`, as another machine
/// would. The first connection can wait while Tailscale makes the
/// certificate.
async fn reach(url: &str) -> Reached {
    let http = slopmax_core::net::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .handshake_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(35))
        .build();
    let response = match http
        .get(format!("{url}/healthz"))
        .bearer_auth(TAILNET_TOKEN)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Reached::Failed,
    };
    let status = response.status().as_u16();
    if status != 200 {
        return Reached::Status(status);
    }
    let body: serde_json::Value = response
        .bytes()
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if body["via"] == "tailnet" {
        Reached::Tailnet
    } else {
        Reached::Elsewhere
    }
}

/// `slopmax tailscale off`: stops publishing each port that serves this
/// home's slopmax, and nothing else.
async fn off(config: &Config) -> Result<()> {
    let ts = Tailscale::find().map_err(fail)?;
    let serve = ts.serve_state().await.map_err(fail)?;
    let targets = targets(config);
    let mut ports: Vec<u16> = serve
        .handlers
        .iter()
        .filter(|h| !h.foreground && tailscale::ours(h, &targets))
        .map(|h| h.port)
        .collect();
    ports.dedup();
    if ports.is_empty() {
        println!("slopmax isn't published to your tailnet.");
        return Ok(());
    }
    for port in ports {
        match ts.unpublish(port).await {
            Ok(()) => {}
            // Root-only: something else on this machine serves a socket.
            Err(TsError::AccessDenied | TsError::RootOnly) => {
                return Err(access_denied("off", &tailscale::serve_off(port)));
            }
            Err(e) => return Err(fail(e)),
        }
    }
    println!(
        "Stopped publishing slopmax to your tailnet. It still runs on {}. Machines that use it \
         as their hub fail until it is on again.",
        config.base_url()
    );
    Ok(())
}

/// `slopmax tailscale [status]`.
async fn status(config: &Config, json: bool) -> Result<()> {
    let ts = Tailscale::find().ok();
    let port = config.listen.port();
    let inspection = tailscale::inspect(ts.as_ref(), &targets(config), port).await;
    if json {
        let from_daemon = match super::daemon(config).await {
            Ok(Some(client)) => client.tailnet().await.ok(),
            _ => None,
        };
        let view = from_daemon.unwrap_or_else(|| tailscale::with_config(inspection.view(), config));
        println!("{}", serde_json::to_string_pretty(&view)?);
        return Ok(());
    }
    let row = |label: &str, text: String| println!("{}  {text}", ui::pad(label, 11));
    let node = match &inspection.node {
        Ok(node) => match tailscale::state_error(node) {
            Some(e) => Err(e),
            None => Ok(node),
        },
        Err(e) => Err(e.clone()),
    };
    let node = match node {
        Ok(node) => {
            let who = match &node.login {
                Some(login) => login.clone(),
                None => format!("tagged {}", node.tags.join(", ")),
            };
            row(
                "Tailscale",
                format!("running, {who} on {} ({})", node.name, node.version),
            );
            Some(node)
        }
        Err(e) => {
            let fix = e.fix().map(|f| format!(" ({f})")).unwrap_or_default();
            row("Tailscale", format!("{}{fix}", e.message()));
            None
        }
    };
    if node.is_some_and(|n| n.cert_domains.is_empty()) {
        let e = TsError::NoHttps;
        row(
            "HTTPS",
            ui::red(format!("{} ({})", e.message(), e.fix().unwrap_or_default())),
        );
    }
    for p in &inspection.published {
        row(
            "Published",
            format!("{} -> {}", p.url, p.target.shown(home())),
        );
        if p.funnel {
            let e = TsError::Funnel { port: p.port };
            row(
                "Funnel",
                ui::red(format!("{}: {}", e.message(), e.fix().unwrap_or_default())),
            );
        }
    }
    for h in &inspection.stale {
        if tailscale::older_private(h, config.listen.port()) {
            row(
                "Stale",
                ui::yellow(format!(
                    "port {} serves slopmax at an older owner key's private path: `slopmax \
                     tailscale on`",
                    h.port
                )),
            );
            continue;
        }
        row(
            "Stale",
            ui::yellow(format!(
                "port {} serves {}, likely slopmax from before: `{}`, then `slopmax \
                 tailscale on`",
                h.port,
                h.target,
                tailscale::serve_off(h.port)
            )),
        );
    }
    if node.is_some() && inspection.published.is_empty() {
        row(
            "Published",
            "no; `slopmax tailscale on` publishes slopmax to your tailnet".into(),
        );
    }
    let users = config.tailnet_users();
    let named = inspection
        .published
        .iter()
        .any(|p| p.transport.names_caller());
    let loopback_only = !inspection.published.is_empty() && !named;
    let identity = !users.is_empty() && !loopback_only;
    let no_key = if loopback_only {
        "nobody: Tailscale here can't tell slopmax who is asking".to_owned()
    } else if users.is_empty() {
        "nobody yet: slopmax tailscale users add <login>".to_owned()
    } else {
        format!("{} (use and view)", users.join(", "))
    };
    row("No key for", no_key);
    let admins: Vec<&str> = config
        .tailscale
        .iter()
        .flat_map(|t| t.admins.iter().map(|a| a.machine.as_str()))
        .collect();
    row(
        "Admins",
        if admins.is_empty() {
            "none (slopmax tailscale admins add <machine>)".to_owned()
        } else {
            admins.join(", ")
        },
    );
    row(
        "Key needed",
        if identity {
            "tagged machines, other logins".to_owned()
        } else {
            "every machine (slopmax key add <name>)".to_owned()
        },
    );
    Ok(())
}

/// Checks that `login` reads as a tailnet login.
fn check_login(login: &str) -> Result<()> {
    let plain =
        login.contains('@') && !login.contains("=?") && login.chars().all(|c| c.is_ascii_graphic());
    if !plain {
        bail!("{login:?} is not a tailnet login, such as you@github");
    }
    Ok(())
}

/// Adds `login` to `users`, unless it is there in some case already.
fn add_user(users: &mut Vec<String>, login: &str) -> Result<()> {
    check_login(login)?;
    if !users.iter().any(|u| u.eq_ignore_ascii_case(login)) {
        users.push(login.to_owned());
    }
    Ok(())
}

/// Adds `admin`, or renames it when its id is there already.
fn add_admin(admins: &mut Vec<AdminMachine>, admin: AdminMachine) {
    match admins.iter_mut().find(|a| a.id == admin.id) {
        Some(known) => *known = admin,
        None => admins.push(admin),
    }
}

/// The admin entry for the machine of `peers` that `query` names. Only an
/// untagged machine signed in as one of `users` may manage slopmax: the
/// hub checks both whenever it asks. The hub itself, `here`, is not among
/// `peers`: it manages slopmax with its own key.
fn admin_of(here: &Node, peers: &[Peer], query: &str, users: &[String]) -> Result<AdminMachine> {
    if tailscale::names_node(here, query) {
        bail!(
            "{} is this machine, the hub; it manages slopmax with its own key, so it needs no \
             admin entry. Open the dashboard here with `slopmax dashboard`",
            here.name
        );
    }
    let peer = tailscale::resolve_machine(peers, query).map_err(anyhow::Error::msg)?;
    if !peer.tags.is_empty() {
        bail!(
            "{} is tagged ({}), so Tailscale doesn't say whose it is; it can't manage slopmax",
            peer.name,
            peer.tags.join(", ")
        );
    }
    let Some(login) = &peer.login else {
        bail!("Tailscale doesn't say who {} belongs to", peer.name);
    };
    if !users.iter().any(|u| u.eq_ignore_ascii_case(login)) {
        bail!(
            "{} is signed in as {login}, which isn't let in without a key; add it first: \
             slopmax tailscale users add {login}",
            peer.name
        );
    }
    Ok(AdminMachine {
        machine: peer.name.clone(),
        id: peer.id.clone(),
    })
}

/// Writes `[tailscale]`: through the proxy while it runs, as it is the
/// only writer then; else in config.toml.
async fn save(config: &Config, tailnet: &Tailnet) -> Result<()> {
    let path = home().config();
    if let Some(client) = super::daemon(config).await? {
        let patch = TailnetPatch {
            users: Some(tailnet.users.clone()),
            admins: Some(
                tailnet
                    .admins
                    .iter()
                    .map(|a| api::AdminMachine {
                        machine: a.machine.clone(),
                        id: a.id.clone(),
                    })
                    .collect(),
            ),
        };
        match client.change_tailnet(&patch).await {
            Ok(_) => return Ok(()),
            // A proxy from before the tailnet API: the file, which it then
            // reads again.
            Err(slopmax_client::Error::Api(ApiError::NotFound { .. })) => {
                Config::set_tailnet(&path, tailnet)?;
                let _ = client.sync().await;
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        }
    }
    Config::set_tailnet(&path, tailnet)?;
    Ok(())
}

/// The logins or machines `names` gives, comma-separated.
fn names<'a>(names: &'a str, what: &str, op: &str) -> Result<Vec<&'a str>> {
    let list: Vec<&str> = names
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .collect();
    if list.is_empty() {
        bail!(
            "`slopmax tailscale {what} {op}` needs the {}",
            match what {
                "users" => "login, such as you@github",
                _ => "machine's name",
            }
        );
    }
    Ok(list)
}

/// `slopmax tailscale users list|add|remove`.
async fn users(config: &Config, op: &str, given: &str) -> Result<()> {
    let mut tailnet = config.tailscale.clone().unwrap_or_default();
    match op {
        "add" => {
            let logins = names(given, "users", op)?;
            for login in &logins {
                add_user(&mut tailnet.users, login)?;
            }
            save(config, &tailnet).await?;
            println!(
                "Machines signed in as {} now use slopmax without a key and see its status.",
                logins.join(" or ")
            );
        }
        "remove" => {
            let logins = names(given, "users", op)?;
            for login in &logins {
                let Some(at) = tailnet
                    .users
                    .iter()
                    .position(|u| u.eq_ignore_ascii_case(login))
                else {
                    bail!("{login} isn't among the logins slopmax lets in without a key");
                };
                tailnet.users.remove(at);
            }
            save(config, &tailnet).await?;
            println!(
                "Machines signed in as {} need a key from now on.",
                logins.join(" or ")
            );
        }
        _ => {
            if tailnet.users.is_empty() {
                println!(
                    "No login is let in without a key. `slopmax tailscale users add <login>` \
                     lets one in."
                );
            }
            for user in &tailnet.users {
                println!("{user}");
            }
        }
    }
    Ok(())
}

/// `slopmax tailscale admins list|add|remove`.
async fn admins(config: &Config, op: &str, given: &str) -> Result<()> {
    let mut tailnet = config.tailscale.clone().unwrap_or_default();
    match op {
        "add" => {
            let machines = names(given, "admins", op)?;
            let ts = Tailscale::find().map_err(fail)?;
            let (here, peers) = ts.peers().await.map_err(fail)?;
            let mut added = Vec::new();
            for machine in machines {
                let admin = admin_of(&here, &peers, machine, &tailnet.users)?;
                added.push(admin.machine.clone());
                add_admin(&mut tailnet.admins, admin);
            }
            save(config, &tailnet).await?;
            println!(
                "{} may now manage slopmax too: its settings, accounts and keys.",
                added.join(" and ")
            );
        }
        "remove" => {
            let machines = names(given, "admins", op)?;
            for machine in &machines {
                let Some(at) = tailnet
                    .admins
                    .iter()
                    .position(|a| a.machine.eq_ignore_ascii_case(machine) || a.id == *machine)
                else {
                    bail!("{machine} isn't among the machines that manage slopmax");
                };
                tailnet.admins.remove(at);
            }
            save(config, &tailnet).await?;
            println!("{} may no longer manage slopmax.", machines.join(" and "));
        }
        _ => {
            if tailnet.admins.is_empty() {
                println!(
                    "No machine manages slopmax but this one. `slopmax tailscale admins add \
                     <machine>` lets one."
                );
            }
            for admin in &tailnet.admins {
                println!("{}  {}", ui::bold(&admin.machine), ui::dim(&admin.id));
            }
        }
    }
    Ok(())
}

/// Where this home's slopmax is published on the tailnet, if it is, and
/// whether machines there use it without a key.
pub async fn published_url(config: &Config) -> Option<(String, bool)> {
    let ts = Tailscale::find().ok()?;
    let node = ts.node().await.ok()?;
    let serve = ts.serve_state().await.ok()?;
    let first = tailscale::published(&serve, &node, &targets(config))
        .into_iter()
        .next()?;
    let keyless = first.transport.names_caller() && !config.tailnet_users().is_empty();
    Some((first.url, keyless))
}

/// What `slopmax dashboard --print` says about opening the dashboard from
/// other machines: its tailnet address when published; how to publish it
/// when Tailscale runs here; else to forward the port over ssh.
pub async fn dashboard_hint(config: &Config) -> String {
    let port = config.listen.port();
    let ssh = format!(
        "On another machine, forward the port first: ssh -L {port}:127.0.0.1:{port} <this host>"
    );
    let Ok(ts) = Tailscale::find() else {
        return ssh;
    };
    let Ok(node) = ts.node().await else {
        return ssh;
    };
    if tailscale::state_error(&node).is_some() {
        return ssh;
    }
    let Ok(serve) = ts.serve_state().await else {
        return ssh;
    };
    match tailscale::published(&serve, &node, &targets(config)).first() {
        Some(p) => {
            let keyless = p.transport.names_caller() && !config.tailnet_users().is_empty();
            format!(
                "From your other machines and phone: {}/slopmax/ ({})",
                p.url,
                if keyless {
                    "no key needed"
                } else {
                    "it asks for this key"
                }
            )
        }
        None => "To open it from your other machines, run slopmax tailscale on".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(name: &str, login: Option<&str>, tags: &[&str]) -> Peer {
        Peer {
            id: format!("n{name}CNTRL"),
            dns_name: format!("{name}.example.ts.net"),
            name: name.into(),
            host_name: name.into(),
            online: true,
            tags: tags.iter().map(|t| t.to_string()).collect(),
            login: login.map(str::to_owned),
            os: "linux".into(),
            ips: Vec::new(),
        }
    }

    #[test]
    fn admins_are_untagged_machines_of_a_login_let_in() {
        let peers = [
            peer("mac", Some("me@github"), &[]),
            peer("ci", None, &["tag:ci"]),
            peer("work", Some("work@corp.com"), &[]),
        ];
        let users = vec!["Me@GitHub".to_owned()];
        let here = Node {
            backend_state: BackendState::Running,
            dns_name: "hub.example.ts.net".into(),
            name: "hub".into(),
            ips: Vec::new(),
            tags: Vec::new(),
            login: Some("me@github".into()),
            cert_domains: Vec::new(),
            magic_dns_suffix: None,
            version: "1.104.5".into(),
            id: "nhubCNTRL".into(),
        };
        let admin_of =
            |peers: &[Peer], query: &str, users: &[String]| admin_of(&here, peers, query, users);
        for query in ["hub", "HUB", "hub.example.ts.net."] {
            let itself = admin_of(&peers, query, &users).unwrap_err().to_string();
            assert!(itself.contains("hub is this machine, the hub"), "{itself}");
        }
        assert_eq!(
            admin_of(&peers, "mac", &users).unwrap(),
            AdminMachine {
                machine: "mac".into(),
                id: "nmacCNTRL".into()
            }
        );
        let tagged = admin_of(&peers, "ci", &users).unwrap_err().to_string();
        assert!(tagged.contains("tagged (tag:ci)"), "{tagged}");
        let other = admin_of(&peers, "work", &users).unwrap_err().to_string();
        assert!(
            other.contains("slopmax tailscale users add work@corp.com"),
            "{other}"
        );
        let missing = admin_of(&peers, "phone", &users).unwrap_err().to_string();
        assert!(
            missing.contains("no machine on your tailnet is called phone"),
            "{missing}"
        );
    }

    #[test]
    fn other_machines_find_the_hub_by_name_only_on_the_usual_port() {
        let url = "https://hub.example.ts.net:7567";
        assert_eq!(setup_command("hub", url, 7567), "slopmax setup --hub hub");
        let url = "https://hub.example.ts.net:7568";
        assert_eq!(
            setup_command("hub", url, 7568),
            format!("slopmax setup --hub {url}")
        );
    }

    #[test]
    fn logins_and_admins_are_added_once() {
        let mut users = vec!["me@github".to_owned()];
        add_user(&mut users, "ME@github").unwrap();
        add_user(&mut users, "you@github").unwrap();
        assert_eq!(users, ["me@github", "you@github"]);
        for bad in ["me", "=?utf-8?q?x?=@github", "me @github"] {
            assert!(add_user(&mut users, bad).is_err(), "{bad}");
        }
        let mut admins = Vec::new();
        let mac = |machine: &str| AdminMachine {
            machine: machine.into(),
            id: "nMAC".into(),
        };
        add_admin(&mut admins, mac("mac"));
        add_admin(&mut admins, mac("macbook"));
        assert_eq!(admins, [mac("macbook")]);
    }
}
