//! `slopmax setup --hub`: this machine's agents use the slopmax on another
//! of the user's own machines, the hub, instead of a proxy of their own.
//! Only the hub holds and refreshes the accounts' tokens, so no copy here
//! can sign another out.

use std::io::IsTerminal;
use std::time::Duration;

use anyhow::{Result, bail};
use slopmax_client::api::ApiError;
use slopmax_client::api::requests::MakeKey;
use slopmax_client::api::tailnet::Access;
use slopmax_client::{Client, Health};

use super::home;
use crate::{term, ui};
use slopmax_core::agent::{self, AGENTS};
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::{Config, DEFAULT_PORT, HubLink, TAILNET_TOKEN};
use slopmax_core::doctor::access_words;
use slopmax_core::service::Manager;
use slopmax_core::tailscale::{self, Tailscale};

/// The port hubs are looked for on: slopmax's own.
pub const HUB_PORT: u16 = DEFAULT_PORT;

/// How long a hub may take to answer the first time: its Tailscale makes
/// its HTTPS certificate on the first connection.
const FIRST_ANSWER: Duration = Duration::from_secs(30);

/// What `setup --hub` was given.
#[derive(Debug, Default)]
pub struct HubArgs {
    /// `off`, a URL, `host[:port]`, or a machine's name on the tailnet;
    /// empty to look for a hub.
    pub target: String,
    /// `--key`, else `$SLOPMAX_HUB_KEY`.
    pub key: Option<String>,
    /// `--name`: what a key made with the hub's owner key is called.
    pub name: Option<String>,
    /// `--yes`: ask nothing, taking the recommended answers.
    pub yes: bool,
}

/// A slopmax found on the tailnet.
#[derive(Debug, Clone)]
pub struct Found {
    /// The machine's name on the tailnet.
    pub name: String,
    pub url: String,
    pub version: String,
}

/// `$SLOPMAX_HUB_KEY`, when set.
fn env_key() -> Option<String> {
    std::env::var("SLOPMAX_HUB_KEY")
        .ok()
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
}

/// Whether there is someone at the terminal to answer.
fn at_terminal() -> bool {
    std::io::stdin().is_terminal()
}

/// Points this machine's agents at the hub `args` names, or back at this
/// machine's own proxy for `off`.
pub async fn setup(config: &Config, args: HubArgs) -> Result<()> {
    if args.target == "off" {
        return off(config);
    }
    let given = args.key.clone().or_else(env_key);
    let url = match args.target.trim() {
        "" => pick(args.yes).await?,
        target => resolve(target, given.is_some()).await?,
    };
    let token = given.clone().unwrap_or_else(|| TAILNET_TOKEN.to_owned());
    let client = Client::remote(&url, &token);
    let Some(health) = client.health_within(FIRST_ANSWER).await else {
        bail!(unreachable(&url).await);
    };
    let by_identity = given.is_none()
        && matches!(
            health.access,
            Some(Access::Use | Access::View | Access::Admin)
        );
    let (key, health, minted) = if by_identity {
        (None, health, None)
    } else {
        let key = match given {
            Some(key) => key,
            None => ask_key(&client, &health).await?,
        };
        let keyed = Client::remote(&url, &key);
        let Some(health) = keyed.health_within(FIRST_ANSWER).await else {
            bail!(unreachable(&url).await);
        };
        if health.owner == Some(true) {
            let name = match &args.name {
                Some(name) => name.clone(),
                None => machine_name().await,
            };
            let made = mint(&keyed, &sanitize(&name), args.yes).await?;
            let health = Client::remote(&url, &made.1)
                .health_within(FIRST_ANSWER)
                .await
                .unwrap_or(health);
            (Some(made.1), health, Some(made.0))
        } else {
            verify(&url, &key, &health).await?;
            (Some(key), health, None)
        }
    };
    let link = HubLink {
        url: url.clone(),
        key,
    };
    let mut wired = Config::set_hub(&home().config(), Some(&link))?;
    // The address may come from the environment, not the file.
    wired.listen = config.listen;

    println!("Found slopmax {} at {}", health.version, ui::bold(&url));
    println!("  {}", knows(&health));
    if let Some(name) = &minted {
        println!(
            "  {}",
            ui::dim(format!(
                "Made the key {name:?} on the hub with its owner key, and kept only that one here."
            ))
        );
    }
    for agent in AGENTS {
        let file = agent::setup(agent, &wired, home())?;
        println!(
            "{} now uses the hub {}",
            agent.title(),
            ui::dim(format!("({})", home().show(&file)))
        );
    }
    println!(
        "This machine runs no proxy of its own; its agents use {}'s accounts.",
        host_name(&url)
    );
    println!("{}", ui::dim("Undo with `slopmax setup --hub off`."));
    retire_local(config, args.yes).await
}

/// `setup --hub off`: back to this machine's own proxy and accounts.
fn off(config: &Config) -> Result<()> {
    let mut local = Config::set_hub(&home().config(), None)?;
    local.listen = config.listen;
    for agent in AGENTS {
        let file = agent::setup(agent, &local, home())?;
        println!("  {} {}", ui::green("wired"), ui::dim(home().show(&file)));
    }
    println!(
        "Its agents now use this machine's proxy. Start it with `slopmax proxy start` \
         (or `slopmax proxy install`)."
    );
    Ok(())
}

/// Offers to stop the proxy this machine still runs, and its login
/// service, now that its agents use the hub. The accounts stay, for
/// `slopmax setup --hub off`.
async fn retire_local(config: &Config, yes: bool) -> Result<()> {
    let running = Daemon::new(config).is_running().await;
    let manager = Manager::detect().filter(|m| m.status(home()).installed);
    if !running && manager.is_none() {
        return Ok(());
    }
    let question = "Stop the proxy here and remove its login service? Your accounts here stay, \
                    for `slopmax setup --hub off`.";
    let stop = yes || !at_terminal() || term::confirm(question, true)?;
    if !stop {
        return Ok(());
    }
    if running && background::stop(config).await? {
        println!("Stopped the proxy here.");
    }
    if let Some(manager) = manager {
        let file = manager.uninstall(home())?;
        println!(
            "Removed its login service {}",
            ui::dim(format!("({})", home().show(&file)))
        );
    }
    Ok(())
}

/// What the hub knows this machine as, and what it may do there.
fn knows(health: &Health) -> String {
    let who = match (&health.machine, &health.login) {
        (Some(machine), Some(login)) => format!("{machine} ({login})"),
        (Some(machine), None) => machine.clone(),
        (None, Some(login)) => login.clone(),
        (None, None) => "its key".to_owned(),
    };
    match health.access {
        Some(access) => format!("It knows this machine as {who}: {}.", access_words(access)),
        None => "Its slopmax is older and doesn't say what this machine may do; it takes the key."
            .to_owned(),
    }
}

/// The URL `target` names: a URL as given, `host[:port]` over HTTPS, or a
/// machine on the tailnet by name, with or without a port. A name is looked
/// up in full, as Tailscale's certificate names it. Plain HTTP reaches only
/// this machine, unless a key is used (a hub on a LAN without Tailscale).
async fn resolve(target: &str, keyed: bool) -> Result<String> {
    let url = if target.starts_with("http://") || target.starts_with("https://") {
        target.trim_end_matches('/').to_owned()
    } else {
        let target = target.trim_end_matches('/');
        let (host, port) = match target.rsplit_once(':') {
            Some((host, port)) if has_port(target) => (host, port.to_owned()),
            _ => (target, HUB_PORT.to_string()),
        };
        if !is_machine_name(host) {
            format!("https://{host}:{port}")
        } else {
            let ts = Tailscale::find().map_err(|e| {
                anyhow::anyhow!(
                    "{}, so the machine {host} can't be looked up; pass its address: \
                     slopmax setup --hub https://<host>:{HUB_PORT}",
                    e.message()
                )
            })?;
            let (here, peers) = ts.peers().await.map_err(super::tailscale::fail)?;
            let dns = if tailscale::names_node(&here, host) {
                here.dns_name.clone()
            } else {
                let peer = tailscale::resolve_machine(&peers, host).map_err(anyhow::Error::msg)?;
                peer.dns_name.clone()
            };
            format!("https://{}:{port}", dns.trim_end_matches('.'))
        }
    };
    let host = host_of(&url);
    if host.is_empty() {
        bail!("{url:?} names no machine; give the hub's name or its whole address");
    }
    if url.starts_with("http://") && !is_loopback(host) && !keyed {
        bail!(
            "plain http:// reaches only this machine without a key; use the hub's https:// \
             address, or pass --key for a hub on your LAN"
        );
    }
    Ok(url)
}

/// Whether `host` is a bare tailnet machine name, which Tailscale looks up:
/// no dots, not an address, not `localhost`.
fn is_machine_name(host: &str) -> bool {
    !host.is_empty() && !host.contains(['.', ':', '[']) && !host.eq_ignore_ascii_case("localhost")
}

/// Whether `host[:port]` gives a port.
fn has_port(target: &str) -> bool {
    match target.rsplit_once(':') {
        Some((host, port)) => {
            !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                && (!host.contains(':') || host.ends_with(']'))
        }
        None => false,
    }
}

/// The host of `url`, without its port.
fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed.split(']').next().unwrap_or_default();
    }
    authority.split(':').next().unwrap_or_default()
}

/// The hub's machine name: its host's first label.
pub fn host_name(url: &str) -> String {
    let host = host_of(url);
    if host.parse::<std::net::IpAddr>().is_ok() {
        return host.to_owned();
    }
    host.split('.').next().unwrap_or(host).to_owned()
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The slopmax hubs on the tailnet: each online machine probed at once
/// over HTTPS on [`HUB_PORT`], keeping those that answer as slopmax. An
/// error says why the tailnet couldn't be read.
pub async fn discover() -> Result<Vec<Found>, String> {
    let ts = Tailscale::find().map_err(|e| e.message())?;
    let (_, peers) = ts.peers().await.map_err(|e| e.message())?;
    // All at once, and read in the candidates' order, which is by name.
    let mut probes = Vec::new();
    for (name, url) in tailscale::discovery_candidates(&peers, HUB_PORT) {
        probes.push(tokio::spawn(async move {
            let health = Client::remote(&url, TAILNET_TOKEN)
                .health_within(Duration::from_millis(1500))
                .await?;
            Some(Found {
                name,
                url,
                version: health.version,
            })
        }));
    }
    let mut found = Vec::new();
    for probe in probes {
        if let Ok(Some(hub)) = probe.await {
            found.push(hub);
        }
    }
    Ok(found)
}

/// The hub to use, from those [`discover`] finds: the only one once
/// confirmed, or the one picked.
async fn pick(yes: bool) -> Result<String> {
    let none = format!(
        "no slopmax answered on your tailnet at port {HUB_PORT}; pass one: slopmax setup --hub \
         <machine or URL>"
    );
    let found = discover()
        .await
        .map_err(|why| anyhow::anyhow!("{why}, so no hub can be looked for. {none}"))?;
    match found.as_slice() {
        [] => bail!(none),
        [one] => {
            println!(
                "Found slopmax {} on {} at {}",
                one.version,
                ui::bold(&one.name),
                one.url
            );
            if !yes && at_terminal() && !term::confirm("Use it?", true)? {
                bail!("no hub chosen; pass one: slopmax setup --hub <machine or URL>");
            }
            Ok(one.url.clone())
        }
        several => {
            if yes || !at_terminal() {
                let names: Vec<&str> = several.iter().map(|f| f.name.as_str()).collect();
                bail!(
                    "slopmax runs on {}; pass one: slopmax setup --hub <machine>",
                    names.join(", ")
                );
            }
            let labels: Vec<(String, String)> = several
                .iter()
                .map(|f| {
                    (
                        f.name.clone(),
                        format!("slopmax {} at {}", f.version, f.url),
                    )
                })
                .collect();
            let options: Vec<(&str, &str)> = labels
                .iter()
                .map(|(n, h)| (n.as_str(), h.as_str()))
                .collect();
            let chosen = term::choose("Which machine is the hub?", &options, 0)?;
            Ok(several[chosen].url.clone())
        }
    }
}

/// Asks for a key, saying first why the hub needs one from this machine.
async fn ask_key(client: &Client, health: &Health) -> Result<String> {
    eprintln!("{}", why_a_key(client, health).await);
    let key = if at_terminal() {
        term::read_secret(
            "A key from the hub (its owner key, or one `slopmax key add` made there)",
        )?
    } else {
        String::new()
    };
    if key.is_empty() {
        bail!(
            "the hub needs a key from this machine: pass one with --key or SLOPMAX_HUB_KEY \
             (on the hub, `slopmax key add <name>` makes one)"
        );
    }
    Ok(key)
}

/// Why the hub doesn't know this machine by its tailnet login.
async fn why_a_key(client: &Client, health: &Health) -> String {
    if health.access.is_none() {
        return "The hub's slopmax is older and takes keys only, so this machine needs a key."
            .to_owned();
    }
    let tags = match Tailscale::find() {
        Ok(ts) => ts.node().await.map(|node| node.tags).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if !tags.is_empty() {
        return format!(
            "This machine is tagged ({}), so Tailscale doesn't say who it belongs to; it needs a key.",
            tags.join(", ")
        );
    }
    if health.via.as_deref() != Some("tailnet") {
        return "The hub can't tell who is asking (it isn't reached through its Tailscale's \
                socket), so this machine needs a key."
            .to_owned();
    }
    if let Err(e) = client.status().await
        && let slopmax_client::Error::Api(ApiError::Unauthorized { message }) = &e
    {
        return format!("The hub says: {message}. Until then, this machine needs a key.");
    }
    "The hub doesn't know this machine by its tailnet login, so it needs a key.".to_owned()
}

/// Makes the client key `name` with the hub's owner key; on a name taken,
/// replaces that key when told to. Returns the name and the key.
async fn mint(owner: &Client, name: &str, yes: bool) -> Result<(String, String)> {
    let asked = MakeKey {
        name: name.to_owned(),
        models: Vec::new(),
    };
    match owner.make_key(&asked).await {
        Ok(made) => Ok((made.name, made.key)),
        Err(slopmax_client::Error::Api(ApiError::Conflict { .. })) => {
            eprintln!("The hub already has a key named {name:?}.");
            let replace = yes
                || (at_terminal()
                    && term::confirm("Replace it? The old key stops working.", false)?);
            if !replace {
                bail!(
                    "kept the hub's key {name:?}; name this machine's with --name, or replace \
                     it with --yes"
                );
            }
            owner.remove_key(name).await?;
            let made = owner.make_key(&asked).await?;
            Ok((made.name, made.key))
        }
        Err(e) => Err(e.into()),
    }
}

/// Checks that `key` works as a client key on the hub at `url`. A hub
/// that says what a caller may do has said; an older one is asked for its
/// models with it.
async fn verify(url: &str, key: &str, health: &Health) -> Result<()> {
    let refused = || {
        anyhow::anyhow!(
            "the hub at {url} doesn't take that key; on the hub, `slopmax key list` shows its keys"
        )
    };
    match health.access {
        Some(access) if access >= Access::Use => return Ok(()),
        Some(_) => return Err(refused()),
        None => {}
    }
    let http = slopmax_core::net::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .handshake_timeout(FIRST_ANSWER)
        .timeout(FIRST_ANSWER + Duration::from_secs(5))
        .build();
    let response = http
        .get(format!("{url}/v1/models"))
        .bearer_auth(key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("the hub at {url} didn't answer: {e}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(refused())
    }
}

/// What to call this machine on the hub: its name on the tailnet, else its
/// host name.
async fn machine_name() -> String {
    let on_tailnet = match Tailscale::find() {
        Ok(ts) => ts
            .node()
            .await
            .ok()
            .map(|n| n.name)
            .filter(|n| !n.is_empty()),
        Err(_) => None,
    };
    on_tailnet
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| {
            let out = std::process::Command::new("hostname").output().ok()?;
            Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
        })
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "machine".to_owned())
}

/// `name` as a key name: lowercase letters, digits and dashes.
fn sanitize(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_owned();
    if out.is_empty() {
        "machine".to_owned()
    } else {
        out
    }
}

/// What to say when the hub at `url` doesn't answer, with why when known.
pub async fn unreachable(url: &str) -> String {
    let http = slopmax_core::net::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .handshake_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(5))
        .build();
    let cause = match http.get(format!("{url}/healthz")).send().await {
        Err(e) => Some(e.to_string()),
        Ok(response) if !response.status().is_success() => {
            Some(format!("it answered {}", response.status()))
        }
        Ok(_) => Some("what answers there isn't slopmax".to_owned()),
    };
    let cause = cause.map(|c| format!(" ({c})")).unwrap_or_default();
    format!(
        "the hub at {url} isn't answering{cause}. Check that Tailscale is connected here \
         (`tailscale status`) and that slopmax runs on the hub (`slopmax doctor` there)."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn targets_become_hub_addresses() {
        let resolved = |target: &'static str, keyed| async move { resolve(target, keyed).await };
        assert_eq!(
            resolved("https://hub.example.ts.net:7567/", false)
                .await
                .unwrap(),
            "https://hub.example.ts.net:7567"
        );
        assert_eq!(
            resolved("hub.example.ts.net", false).await.unwrap(),
            "https://hub.example.ts.net:7567"
        );
        assert_eq!(
            resolved("hub.example.ts.net:8443", false).await.unwrap(),
            "https://hub.example.ts.net:8443"
        );
        assert_eq!(
            resolved("localhost:7600", false).await.unwrap(),
            "https://localhost:7600"
        );
        assert_eq!(
            resolved("http://127.0.0.1:7600", false).await.unwrap(),
            "http://127.0.0.1:7600"
        );
        let refused = resolved("http://box.lan:7567", false).await.unwrap_err();
        assert!(refused.to_string().contains("--key"), "{refused}");
        assert_eq!(
            resolved("http://box.lan:7567", true).await.unwrap(),
            "http://box.lan:7567"
        );
    }

    #[test]
    fn hosts_and_names_read_from_urls() {
        assert_eq!(
            host_of("https://hub.example.ts.net:7567/x"),
            "hub.example.ts.net"
        );
        assert_eq!(host_of("http://[::1]:7567"), "::1");
        assert_eq!(host_name("https://hub.example.ts.net:7567"), "hub");
        assert_eq!(host_name("http://127.0.0.1:7567"), "127.0.0.1");
        assert!(has_port("hub.example.ts.net:1"));
        assert!(has_port("hub:7600") && is_machine_name("hub"));
        assert!(!is_machine_name("hub.example.ts.net") && !is_machine_name("localhost"));
        assert!(!is_machine_name("[::1]") && !is_machine_name("100.64.0.1"));
        assert!(!has_port("hub.example.ts.net"));
        assert!(is_loopback("localhost") && is_loopback("::1") && !is_loopback("hub"));
    }

    #[test]
    fn key_names_are_plain() {
        assert_eq!(sanitize("Me’s MacBook Pro"), "me-s-macbook-pro");
        assert_eq!(sanitize("  laptop  "), "laptop");
        assert_eq!(sanitize("!!!"), "machine");
    }

    #[test]
    fn the_hub_says_what_it_knows_this_machine_as() {
        let health = Health {
            version: "1.0.0".into(),
            pid: None,
            owner: Some(false),
            access: Some(Access::View),
            via: Some("tailnet".into()),
            login: Some("me@github".into()),
            machine: Some("mac".into()),
        };
        assert_eq!(
            knows(&health),
            "It knows this machine as mac (me@github): use and view."
        );
        let keyed = Health {
            access: Some(Access::Use),
            login: None,
            machine: Some("laptop".into()),
            ..health.clone()
        };
        assert_eq!(knows(&keyed), "It knows this machine as laptop: use.");
    }
}
