//! The command line: every command, argument, and flag slopmax takes, in
//! one place. usage-rs derives the parser, help, errors, shell completions,
//! and the usage spec (`slopmax __usage_spec__`) from these types; the
//! commands themselves are in [`crate::commands`].
//!
//! The rules the surface keeps:
//!
//! - Things are nouns with verbs under them: `account`, `agent`, `proxy`,
//!   `key`, `tailscale`. A noun alone shows its things (`slopmax account`
//!   lists the accounts). The verbs are the same everywhere: `list`, `add`,
//!   `remove`, `enable`, `disable`, `on`, `off`.
//! - `login` and `run` are shortcuts for `account add` and `agent run`,
//!   the two commands used most.
//! - Every command that prints data takes `--json`; every command that
//!   asks before doing something takes `-y, --yes`.
//! - `<ACCOUNT>` is the same everywhere: a number from `slopmax status`,
//!   or an account's id, email, or label.

use usage_rs::{Args, Cli, Subcommands, ValueEnum};

use crate::commands::complete;

const ENVIRONMENT: &str = "\
Environment:
    SLOPMAX_HOME             Where slopmax keeps its config, accounts, and logs
                             (default: ~/.slopmax)
    SLOPMAX_LISTEN           The address the proxy listens on, over config.toml's listen
    SLOPMAX_HUB_KEY          A hub's key for `setup --hub`, when --hub-key isn't given
    SLOPMAX_LOG              The log level: error, warn, info, debug, or off
    SLOPMAX_NO_UPDATE_CHECK  1 never looks for a newer release
    NO_COLOR                 Print without color

Docs: https://github.com/KaBankz/slopmax#readme";

/// Pool your Claude, ChatGPT, and SuperGrok subscriptions behind one local
/// proxy, so Claude Code, Codex, and Grok Build keep working when an account
/// runs out.
///
/// Run without a command to see your accounts, or to set slopmax up the
/// first time.
#[derive(Cli)]
#[usage(
    bin = "slopmax",
    version,
    completion,
    after_long_help = ENVIRONMENT,
    exit_code(0, "it worked"),
    exit_code(1, "it failed; the error says why"),
    exit_code(2, "the command line was wrong"),
    example("slopmax setup", header = "Set everything up, step by step"),
    example("slopmax login claude", header = "Add another Claude account"),
    example("slopmax run codex", header = "Run Codex through the proxy"),
    example("slopmax status --json", header = "Read the accounts' standing as JSON")
)]
pub struct Slopmax {
    #[usage(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommands)]
pub enum Command {
    // Start here
    /// Set slopmax up step by step, or unattended with flags
    #[usage(display_order = 1, alias = "init", help_heading = "Start here")]
    Setup(Setup),
    /// Show the accounts, their usage windows, and when limits reset
    #[usage(display_order = 2, help_heading = "Start here")]
    Status(Status),
    /// Open the dashboard in a browser, starting the proxy if needed
    #[usage(display_order = 3, help_heading = "Start here")]
    Dashboard(Dashboard),

    // Accounts
    /// Connect an account: sign in, or enter an API key (`account add`)
    #[usage(display_order = 4, help_heading = "Accounts")]
    Login(AccountAdd),
    /// List, add, and manage the accounts slopmax pools
    #[usage(
        display_order = 5,
        alias_hidden = "accounts",
        help_heading = "Accounts"
    )]
    Account(Account),
    /// Show token usage and what it would have cost on the API
    #[usage(display_order = 6, help_heading = "Activity")]
    Usage(Usage),
    /// Show the requests the proxy answered
    #[usage(display_order = 7, help_heading = "Activity")]
    Requests(Requests),

    // Agents
    /// Launch an agent through the proxy (`agent run`)
    #[usage(display_order = 8, help_heading = "Agents")]
    Run(AgentRun),
    /// Point Claude Code, Codex, and Grok Build at slopmax
    #[usage(display_order = 9, alias_hidden = "agents", help_heading = "Agents")]
    Agent(Agent),

    // The proxy
    /// Start, stop, and inspect the proxy, and run it at login
    #[usage(display_order = 10, help_heading = "Proxy")]
    Proxy(Proxy),
    /// Show the routing settings, or change one while the proxy runs
    #[usage(display_order = 11, help_heading = "Proxy")]
    Config(ConfigCmd),
    /// Manage keys that let other machines and tools use the proxy
    #[usage(display_order = 12, alias_hidden = "keys", help_heading = "Proxy")]
    Key(Key),
    /// Share slopmax with your own machines over Tailscale
    #[usage(display_order = 13, help_heading = "Proxy")]
    Tailscale(Tailscale),

    // Maintenance
    /// Check the setup and say how to fix what's wrong
    #[usage(display_order = 14, help_heading = "Maintenance")]
    Doctor(Doctor),
    /// Show how slopmax notifies you, or send a test notification
    #[usage(display_order = 15, help_heading = "Maintenance")]
    Notify(Notify),
    /// Install the newest slopmax and move the running proxy to it
    #[usage(display_order = 16, help_heading = "Maintenance")]
    Update(Update),
    /// Print or install a shell completion script
    #[usage(
        display_order = 17,
        alias_hidden = "completions",
        help_heading = "Maintenance"
    )]
    Completion(usage_rs::completion::Completion),

    /// Run the proxy in the foreground (`proxy serve`); what login
    /// services run
    #[usage(display_order = 18, hide)]
    Serve(ProxyServe),
}

// ---------------------------------------------------------------------------
// Shared flags

/// `--json`, on every command that prints data.
#[derive(Args, Default)]
pub struct Json {
    /// Print JSON instead of text, for scripts and agents
    #[usage(long)]
    pub json: bool,
}

/// `--json` on a noun, for what it shows with no subcommand.
#[derive(Args, Default)]
pub struct ListJson {
    /// With no subcommand: print JSON instead of text, for scripts and agents
    #[usage(long)]
    pub json: bool,
}

/// `-y, --yes`, on every command that asks before it acts.
#[derive(Args, Default)]
pub struct Yes {
    /// Don't ask for confirmation
    #[usage(short = 'y', long)]
    pub yes: bool,
}

// ---------------------------------------------------------------------------
// Start here

/// Set slopmax up step by step, or unattended with flags.
///
/// It finds the logins Claude Code, Codex, and CLIProxyAPI hold and offers to
/// bring them over, signs in to more accounts, picks how accounts are
/// shared, points your agents at the proxy, and starts it at login. Every
/// question has a flag; with --yes, or without a terminal, it asks nothing
/// and takes the flags, else the recommended answers.
///
/// With --hub, this machine uses the slopmax on another of your machines
/// instead, and runs no proxy of its own.
#[derive(Args)]
#[usage(
    effect = "write",
    example(
        "slopmax setup --yes --import claude-code,codex --agents claude,codex",
        header = "Unattended, for a script or an agent"
    ),
    example(
        "slopmax setup --hub workstation",
        header = "Use the slopmax on another of your machines"
    ),
    example(
        "slopmax setup --hub off",
        header = "Go back to this machine's own proxy"
    )
)]
pub struct Setup {
    /// Ask nothing: take the flags, else the recommended answers
    #[usage(short = 'y', long)]
    pub yes: bool,
    /// Take logins from these tools
    #[usage(
        long,
        value_name = "SOURCES",
        delimiter = ',',
        choices("all", "claude-code", "codex", "cliproxyapi", "none")
    )]
    pub import: Vec<String>,
    /// With --import cliproxyapi: refresh its logins here instead of following its files
    #[usage(long)]
    pub adopt: bool,
    /// Sign in to these subscriptions
    #[usage(
        long,
        value_name = "PROVIDERS",
        delimiter = ',',
        choices("claude", "codex", "grok", "none")
    )]
    pub login: Vec<String>,
    /// Add the keys set in ANTHROPIC_API_KEY, OPENAI_API_KEY, and XAI_API_KEY
    #[usage(long)]
    pub keys_from_env: bool,
    /// How new sessions pick an account
    #[usage(long, value_enum)]
    pub strategy: Option<StrategyArg>,
    /// Keep each session on its account (on), or place every request afresh (off)
    #[usage(long, value_enum)]
    pub affinity: Option<OnOff>,
    /// Point these agents at the proxy
    #[usage(
        long,
        value_name = "AGENTS",
        delimiter = ',',
        choices("claude", "codex", "grok", "none")
    )]
    pub agents: Vec<String>,
    /// Don't start slopmax at login
    #[usage(long)]
    pub no_service: bool,
    /// Use the slopmax on another of your machines: its name, host[:port], or URL; `off` goes back
    #[usage(long, value_name = "HUB", help_heading = "Using a hub")]
    pub hub: Option<String>,
    /// Look for slopmax on your tailnet, and use it
    #[usage(long, conflicts("--hub"), help_heading = "Using a hub")]
    pub find_hub: bool,
    /// A key the hub made for this machine (else $SLOPMAX_HUB_KEY)
    #[usage(long, value_name = "KEY", help_heading = "Using a hub")]
    pub hub_key: Option<String>,
    /// With the hub's owner key: the name of the key made for this machine
    #[usage(long, value_name = "NAME", help_heading = "Using a hub")]
    pub key_name: Option<String>,
}

/// Show the accounts, their usage windows, and when limits reset.
///
/// Reads the running proxy, else the files on disk. Accounts are numbered;
/// commands that take <ACCOUNT> take those numbers.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct Status {
    /// Fetch fresh usage from the providers first
    #[usage(short = 'r', long)]
    pub refresh: bool,
    /// Keep the display up to date until interrupted
    #[usage(short = 'w', long, conflicts("--json"))]
    pub watch: bool,
    #[usage(flatten)]
    pub json: Json,
}

/// Open the dashboard in a browser, starting the proxy if needed.
#[derive(Args)]
#[usage(effect = "write")]
pub struct Dashboard {
    /// Print the dashboard's address instead of opening a browser
    #[usage(long)]
    pub no_browser: bool,
}

// ---------------------------------------------------------------------------
// Accounts

/// List, add, and manage the accounts slopmax pools.
///
/// Without a subcommand, lists the accounts.
#[derive(Args)]
#[usage(effect = "read")]
pub struct Account {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<AccountCommand>,
}

#[derive(Subcommands)]
pub enum AccountCommand {
    /// List the accounts, numbered
    #[usage(display_order = 1, alias = "ls")]
    List(AccountList),
    /// Connect an account: sign in, or enter an API key
    #[usage(display_order = 2)]
    Add(AccountAdd),
    /// Copy the logins Claude Code, Codex, or CLIProxyAPI hold
    #[usage(display_order = 3)]
    Import(AccountImport),
    /// Prefer an account for new sessions, or let slopmax choose again
    #[usage(display_order = 4)]
    Use(AccountUse),
    /// Set an account's display name
    #[usage(display_order = 5)]
    Rename(AccountRename),
    /// Set an account's priority tier; higher tiers are used first
    #[usage(display_order = 6)]
    Priority(AccountPriority),
    /// Show or set the order new sessions use accounts in
    #[usage(display_order = 7)]
    Order(AccountOrder),
    /// Route to an account again
    #[usage(display_order = 8)]
    Enable(AccountRef),
    /// Stop routing to an account; its sign-in is still kept fresh
    #[usage(display_order = 9)]
    Disable(AccountRef),
    /// Lift slopmax's hold on an account and read its usage again
    #[usage(display_order = 10)]
    Check(AccountCheck),
    /// Spend a banked limit reset, resetting the account's usage windows
    #[usage(display_order = 11)]
    Redeem(AccountRedeem),
    /// Take over refreshing a login slopmax follows from another tool
    #[usage(display_order = 12)]
    Adopt(AccountAdopt),
    /// Forget an account
    #[usage(display_order = 13, alias = "rm")]
    Remove(AccountRemove),
}

/// List the accounts, numbered.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct AccountList {
    #[usage(flatten)]
    pub json: Json,
}

/// Connect an account: sign in, or enter an API key.
///
/// Subscriptions (claude, codex, grok) sign in through the provider's own
/// page. API keys are asked for at a hidden prompt, or read from stdin
/// (`slopmax login xai < key.txt`). A compatible endpoint needs --url.
#[derive(Args)]
#[usage(
    effect = "write",
    example(
        "slopmax login claude",
        header = "Sign in to a Claude Pro or Max account"
    ),
    example(
        "slopmax login codex --device",
        header = "Sign in with a code, from a machine with no browser"
    ),
    example(
        "slopmax login compat --url http://localhost:11434/v1",
        header = "Add a local OpenAI-compatible endpoint"
    )
)]
pub struct AccountAdd {
    /// Which kind of account
    #[usage(value_enum)]
    pub provider: ProviderArg,
    /// Display name for the account (else its email)
    #[usage(long)]
    pub label: Option<String>,
    /// Sign in with a code to enter on any device, instead of a browser redirect
    #[usage(long)]
    pub device: bool,
    /// Print the sign-in address instead of opening a browser
    #[usage(long)]
    pub no_browser: bool,
    /// The endpoint's base URL
    #[usage(long, value_hint = usage_rs::ValueHint::Url, help_heading = "Compatible endpoints")]
    pub url: Option<String>,
    /// The API it speaks
    #[usage(
        long,
        value_enum,
        requires("--url"),
        help_heading = "Compatible endpoints"
    )]
    pub dialect: Option<DialectArg>,
    /// Models it serves, as patterns (else what it lists)
    #[usage(
        long,
        value_name = "MODELS",
        delimiter = ',',
        requires("--url"),
        help_heading = "Compatible endpoints"
    )]
    pub models: Vec<String>,
}

/// Copy the logins Claude Code, Codex, or CLIProxyAPI hold.
///
/// An imported login shares its refresh token with the tool it came from.
/// CLIProxyAPI's are followed: slopmax reads the files CLIProxyAPI keeps
/// fresh and never refreshes them itself, until `slopmax account adopt`.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AccountImport {
    /// Where to import from
    #[usage(value_enum, default = "all")]
    pub source: SourceArg,
    /// Refresh CLIProxyAPI's logins here instead of following its files
    #[usage(long)]
    pub adopt: bool,
}

/// Prefer an account for new sessions, or let slopmax choose again.
///
/// New sessions of that provider go to the account while it has quota.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AccountUse {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts, required_unless("--auto"), conflicts("--auto"))]
    pub account: Option<String>,
    /// Let slopmax choose accounts again
    #[usage(long)]
    pub auto: bool,
}

/// Set an account's display name.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AccountRename {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts)]
    pub account: String,
    /// The new name; "" goes back to the email
    pub label: String,
}

/// Set an account's priority tier; higher tiers are used first.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AccountPriority {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts)]
    pub account: String,
    /// The tier: 0 by default; negative holds the account in reserve
    #[usage(allow_negative_numbers)]
    pub tier: i32,
}

/// Show or set the order new sessions use accounts in.
///
/// With accounts, puts them first, in the order given; the rest follow as
/// they were.
#[derive(Args)]
#[usage(
    effect = "write",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    ),
    example("slopmax account order 3 1", header = "Use account 3 first, then 1")
)]
pub struct AccountOrder {
    /// Accounts to use first, in order
    #[usage(complete = complete::accounts)]
    pub accounts: Vec<String>,
    #[usage(flatten)]
    pub json: Json,
}

/// An account, for the commands that take one and nothing else.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AccountRef {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts)]
    pub account: String,
}

/// Lift slopmax's hold on an account and read its usage again.
#[derive(Args)]
#[usage(
    effect = "write",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct AccountCheck {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts)]
    pub account: String,
    #[usage(flatten)]
    pub json: Json,
}

/// Spend a banked limit reset, resetting the account's usage windows.
///
/// Claude and ChatGPT accounts can hold limit resets; this spends the one
/// that expires soonest.
#[derive(Args)]
#[usage(effect = "destructive")]
pub struct AccountRedeem {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts)]
    pub account: String,
    #[usage(flatten)]
    pub yes: Yes,
}

/// Take over refreshing a login slopmax follows from another tool.
///
/// The first refresh signs the other tool's copy out, so stop that tool
/// first.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AccountAdopt {
    /// A number from `slopmax status`, the account's id, email, or label, or `all`
    #[usage(complete = complete::adoptable)]
    pub account: String,
}

/// Forget an account.
#[derive(Args)]
#[usage(effect = "destructive")]
pub struct AccountRemove {
    /// A number from `slopmax status`, or the account's id, email, or label
    #[usage(complete = complete::accounts)]
    pub account: String,
    #[usage(flatten)]
    pub yes: Yes,
}

/// Show token usage and what it would have cost on the API.
#[derive(Args)]
#[usage(
    effect = "read",
    example("slopmax usage 30d --by model", header = "The last 30 days, by model"),
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct Usage {
    /// Which period
    #[usage(value_enum, default = "7d")]
    pub range: UsageRange,
    /// What to group by
    #[usage(short = 'b', long, value_enum, default = "day")]
    pub by: UsageBy,
    #[usage(flatten)]
    pub json: Json,
}

/// Show the requests the proxy answered, newest first.
#[derive(Args)]
#[usage(
    effect = "read",
    example(
        "slopmax requests --failed --limit 5",
        header = "The last five requests that failed"
    ),
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct Requests {
    /// Which period
    #[usage(value_enum, default = "today")]
    pub range: RequestsRange,
    /// Only those served by this account
    #[usage(long, complete = complete::accounts)]
    pub account: Option<String>,
    /// Only this model
    #[usage(long)]
    pub model: Option<String>,
    /// Only those that failed
    #[usage(long)]
    pub failed: bool,
    /// How many to show, at most 1000
    #[usage(short = 'n', long, default = "20")]
    pub limit: usize,
    /// How many of the newest to skip, to page back
    #[usage(long, default = "0")]
    pub offset: usize,
    #[usage(flatten)]
    pub json: Json,
}

// ---------------------------------------------------------------------------
// Agents

/// Point Claude Code, Codex, and Grok Build at slopmax.
///
/// Without a subcommand, lists the agents and whether each is connected.
#[derive(Args)]
#[usage(effect = "read")]
pub struct Agent {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<AgentCommand>,
}

#[derive(Subcommands)]
pub enum AgentCommand {
    /// List the agents and whether each is connected
    #[usage(display_order = 1, alias = "ls")]
    List(AgentList),
    /// Point an agent at slopmax for good, in its own config file
    #[usage(display_order = 2)]
    Connect(AgentName),
    /// Restore what `agent connect` replaced
    #[usage(display_order = 3)]
    Disconnect(AgentName),
    /// Launch an agent through the proxy, starting the proxy if needed
    #[usage(display_order = 4)]
    Run(AgentRun),
    /// Print shell setup that points an agent at the proxy, for `eval`
    #[usage(display_order = 5)]
    Env(AgentEnv),
}

/// List the agents and whether each is connected.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct AgentList {
    #[usage(flatten)]
    pub json: Json,
}

/// One agent.
#[derive(Args)]
#[usage(effect = "write")]
pub struct AgentName {
    /// Which agent
    #[usage(value_enum)]
    pub agent: AgentArg,
}

/// Print shell setup that points an agent at the proxy, for `eval`.
#[derive(Args)]
#[usage(
    effect = "read",
    example(
        "eval \"$(slopmax agent env claude)\"",
        header = "Point this shell's Claude Code at slopmax"
    )
)]
pub struct AgentEnv {
    /// Which agent
    #[usage(value_enum)]
    pub agent: AgentArg,
}

/// Launch an agent through the proxy, starting the proxy if needed.
///
/// Everything after the agent goes to it unchanged, and slopmax exits with
/// the agent's own exit status.
#[derive(Args)]
#[usage(
    effect = "write",
    example(
        "slopmax run claude --continue",
        header = "Continue the last Claude Code session"
    )
)]
pub struct AgentRun {
    /// Which agent
    #[usage(value_enum)]
    pub agent: AgentArg,
    /// Arguments for the agent
    #[usage(double_dash = "automatic")]
    pub args: Vec<String>,
}

// ---------------------------------------------------------------------------
// The proxy

/// Start, stop, and inspect the proxy, and run it at login.
///
/// Without a subcommand, shows whether the proxy runs.
#[derive(Args)]
#[usage(effect = "read")]
pub struct Proxy {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<ProxyCommand>,
}

#[derive(Subcommands)]
pub enum ProxyCommand {
    /// Show whether the proxy runs, where, and whether it starts at login
    #[usage(display_order = 1)]
    Status(ProxyStatus),
    /// Start the proxy in the background
    #[usage(display_order = 2)]
    Start(ProxyStart),
    /// Stop the background proxy
    #[usage(display_order = 3)]
    Stop(ProxyStop),
    /// Stop the proxy and start it again
    #[usage(display_order = 4)]
    Restart(ProxyRestart),
    /// Show the proxy's log
    #[usage(display_order = 5)]
    Logs(ProxyLogs),
    /// Start the proxy at login (a systemd user unit, launchd agent, or Windows login item)
    #[usage(display_order = 6)]
    Install(ProxyInstall),
    /// Stop starting the proxy at login
    #[usage(display_order = 7)]
    Uninstall(ProxyUninstall),
    /// Run the proxy in the foreground
    #[usage(display_order = 8)]
    Serve(ProxyServe),
}

/// Show whether the proxy runs, where, and whether it starts at login.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct ProxyStatus {
    #[usage(flatten)]
    pub json: Json,
}

/// Start the proxy in the background.
#[derive(Args)]
#[usage(effect = "write")]
pub struct ProxyStart;

/// Stop the background proxy.
#[derive(Args)]
#[usage(effect = "write")]
pub struct ProxyStop;

/// Stop the proxy and start it again.
#[derive(Args)]
#[usage(effect = "write")]
pub struct ProxyRestart;

/// Start the proxy at login.
#[derive(Args)]
#[usage(effect = "write")]
pub struct ProxyInstall;

/// Stop starting the proxy at login.
#[derive(Args)]
#[usage(effect = "write")]
pub struct ProxyUninstall;

/// Run the proxy in the foreground.
#[derive(Args)]
#[usage(effect = "write")]
pub struct ProxyServe;

/// Show the proxy's log.
#[derive(Args)]
#[usage(effect = "read")]
pub struct ProxyLogs {
    /// Keep printing new lines until interrupted
    #[usage(short = 'f', long)]
    pub follow: bool,
    /// How many lines to show first
    #[usage(short = 'n', long, default = "40")]
    pub lines: usize,
}

/// Show the routing settings, or change one while the proxy runs.
///
/// A change applies at once to a running proxy, and is saved to
/// config.toml. The other settings live in config.toml itself.
#[derive(Args)]
#[usage(
    effect = "write",
    example(
        "slopmax config strategy round-robin",
        header = "Take turns between accounts"
    ),
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct ConfigCmd {
    /// The setting, e.g. strategy
    #[usage(complete = complete::settings)]
    pub name: Option<String>,
    /// Its new value, e.g. round-robin
    #[usage(complete = complete::setting_values)]
    pub value: Option<String>,
    #[usage(flatten)]
    pub json: Json,
}

/// Manage keys that let other machines and tools use the proxy.
///
/// Without a subcommand, lists the keys.
#[derive(Args)]
#[usage(effect = "read")]
pub struct Key {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<KeyCommand>,
}

#[derive(Subcommands)]
pub enum KeyCommand {
    /// List the keys
    #[usage(display_order = 1, alias = "ls")]
    List(KeyList),
    /// Make a key, and print it once
    #[usage(display_order = 2)]
    Add(KeyAdd),
    /// Revoke a key
    #[usage(display_order = 3, alias = "rm")]
    Remove(KeyRemove),
}

/// List the keys.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct KeyList {
    #[usage(flatten)]
    pub json: Json,
}

/// Make a key, and print it once.
#[derive(Args)]
#[usage(
    effect = "write",
    example("slopmax key add laptop", header = "A key for your laptop")
)]
pub struct KeyAdd {
    /// What to call it
    pub name: String,
    /// Models it may use, as patterns (else any)
    #[usage(long, value_name = "MODELS", delimiter = ',')]
    pub models: Vec<String>,
}

/// Revoke a key.
#[derive(Args)]
#[usage(effect = "destructive")]
pub struct KeyRemove {
    /// The key's name
    #[usage(complete = complete::keys)]
    pub name: String,
    #[usage(flatten)]
    pub yes: Yes,
}

/// Share slopmax with your own machines over Tailscale.
///
/// Without a subcommand, shows whether slopmax is published to your
/// tailnet, and who uses it.
#[derive(Args)]
#[usage(effect = "read")]
pub struct Tailscale {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<TailscaleCommand>,
}

#[derive(Subcommands)]
pub enum TailscaleCommand {
    /// Show whether slopmax is published to your tailnet, and who uses it
    #[usage(display_order = 1)]
    Status(TailscaleStatus),
    /// Publish slopmax to your own machines with `tailscale serve`
    #[usage(display_order = 2)]
    On(TailscaleOn),
    /// Stop publishing slopmax to your tailnet
    #[usage(display_order = 3)]
    Off(TailscaleOff),
    /// The tailnet logins whose machines use slopmax without a key
    #[usage(display_order = 4, alias_hidden = "users")]
    User(TailnetUsers),
    /// The machines that may also manage slopmax
    #[usage(display_order = 5, alias_hidden = "admins")]
    Admin(TailnetAdmins),
}

/// Show whether slopmax is published to your tailnet, and who uses it.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct TailscaleStatus {
    #[usage(flatten)]
    pub json: Json,
}

/// Publish slopmax to your own machines with `tailscale serve`.
#[derive(Args)]
#[usage(
    effect = "write",
    example(
        "slopmax tailscale on --user you@github",
        header = "Let your own machines in without a key"
    )
)]
pub struct TailscaleOn {
    /// The port to serve on (else the proxy's)
    #[usage(long)]
    pub port: Option<u16>,
    /// A tailnet login to let in without a key
    #[usage(long, value_name = "LOGIN", delimiter = ',')]
    pub user: Vec<String>,
    /// A machine that may also manage slopmax
    #[usage(long, value_name = "MACHINE", delimiter = ',')]
    pub admin: Vec<String>,
    /// Serve the proxy's bare port, where every machine needs a key
    #[usage(long, conflicts("--socket"))]
    pub loopback: bool,
    /// Serve the proxy's socket, which Tailscale lets only root publish
    #[usage(long)]
    pub socket: bool,
}

/// Stop publishing slopmax to your tailnet.
#[derive(Args)]
#[usage(effect = "write")]
pub struct TailscaleOff;

/// The tailnet logins whose machines use slopmax without a key.
///
/// Without a subcommand, lists them.
#[derive(Args)]
#[usage(effect = "read")]
pub struct TailnetUsers {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<UserCommand>,
}

#[derive(Subcommands)]
pub enum UserCommand {
    /// List the logins let in without a key
    #[usage(display_order = 1, alias = "ls")]
    List(TailnetShow),
    /// Let these logins' machines in without a key
    #[usage(display_order = 2)]
    Add(Logins),
    /// Make these logins' machines use a key again
    #[usage(display_order = 3, alias = "rm")]
    Remove(Logins),
}

/// The machines that may also manage slopmax: its settings, accounts, and
/// keys.
///
/// Without a subcommand, lists them.
#[derive(Args)]
#[usage(effect = "read")]
pub struct TailnetAdmins {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<AdminCommand>,
}

#[derive(Subcommands)]
pub enum AdminCommand {
    /// List the machines that may manage slopmax
    #[usage(display_order = 1, alias = "ls")]
    List(TailnetShow),
    /// Let these machines manage slopmax
    #[usage(display_order = 2)]
    Add(Machines),
    /// Stop these machines managing slopmax
    #[usage(display_order = 3, alias = "rm")]
    Remove(Machines),
}

/// List them.
#[derive(Args)]
#[usage(
    effect = "read",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct TailnetShow {
    #[usage(flatten)]
    pub json: Json,
}

/// Tailnet logins.
#[derive(Args)]
#[usage(effect = "write")]
pub struct Logins {
    /// Tailnet logins, such as you@github
    #[usage(arg, required, value_name = "LOGIN", delimiter = ',')]
    pub logins: Vec<String>,
}

/// Tailnet machines.
#[derive(Args)]
#[usage(effect = "write")]
pub struct Machines {
    /// Machine names, as Tailscale shows them
    #[usage(arg, required, value_name = "MACHINE", delimiter = ',')]
    pub machines: Vec<String>,
}

// ---------------------------------------------------------------------------
// Maintenance

/// Check the setup and say how to fix what's wrong.
#[derive(Args)]
#[usage(
    effect = "read",
    exit_code(0, "nothing is broken"),
    exit_code(1, "something is broken"),
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct Doctor {
    #[usage(flatten)]
    pub json: Json,
}

/// Show how slopmax notifies you, or send a test notification.
///
/// Without a subcommand, shows where notices go and which events send one
/// (`--json` prints that as JSON). Notifications are set under [notify] in
/// config.toml.
#[derive(Args)]
#[usage(effect = "read")]
pub struct Notify {
    #[usage(flatten)]
    pub json: ListJson,
    #[usage(subcommand)]
    pub command: Option<NotifyCommand>,
}

#[derive(Subcommands)]
pub enum NotifyCommand {
    /// Send a test notification
    #[usage(display_order = 1)]
    Test(NotifyTest),
}

/// Send a test notification.
#[derive(Args)]
#[usage(effect = "write")]
pub struct NotifyTest;

/// Install the newest slopmax and move the running proxy to it.
///
/// It updates the way slopmax was installed, and the proxy changes over
/// without dropping a connection.
#[derive(Args)]
#[usage(
    effect = "write",
    output("human", default),
    output(
        "json",
        media_type = "application/json",
        framing = "json",
        select = "--json"
    )
)]
pub struct Update {
    /// Only say whether a newer release is out
    #[usage(long)]
    pub check: bool,
    /// With --check: print JSON instead of text, for scripts and agents
    #[usage(long, requires("--check"))]
    pub json: bool,
}

// ---------------------------------------------------------------------------
// Values

/// Which kind of account.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProviderArg {
    /// Claude Pro or Max, used by Claude Code
    Claude,
    /// ChatGPT Plus, Pro, or Team, used by Codex
    Codex,
    /// SuperGrok, used by Grok Build
    Grok,
    /// An Anthropic API key
    Anthropic,
    /// An OpenAI API key
    Openai,
    /// An xAI API key
    Xai,
    /// Any OpenAI- or Anthropic-compatible endpoint (needs --url)
    Compat,
}

impl ProviderArg {
    pub fn word(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Xai => "xai",
            Self::Compat => "compat",
        }
    }
}

/// Which agent.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentArg {
    /// Claude Code
    Claude,
    /// Codex
    Codex,
    /// Grok Build
    Grok,
}

impl AgentArg {
    pub fn word(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
        }
    }
}

/// Where to import logins from.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SourceArg {
    /// Every source below
    All,
    /// Claude Code's login (~/.claude/.credentials.json, or the macOS keychain)
    ClaudeCode,
    /// The Codex CLI's login (~/.codex/auth.json)
    Codex,
    /// CLIProxyAPI's credential files (~/.cli-proxy-api/*.json)
    Cliproxyapi,
}

impl SourceArg {
    pub fn word(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Cliproxyapi => "cliproxyapi",
        }
    }
}

/// How new sessions pick an account.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum StrategyArg {
    /// The quota that resets soonest, so less of it goes unused
    ResetFirst,
    /// Accounts in a fixed order, the next only when one is limited
    FillFirst,
    /// The account with the most quota left
    LeastUsed,
    /// Each account in turn
    RoundRobin,
}

impl StrategyArg {
    pub fn word(self) -> &'static str {
        match self {
            Self::ResetFirst => "reset-first",
            Self::FillFirst => "fill-first",
            Self::LeastUsed => "least-used",
            Self::RoundRobin => "round-robin",
        }
    }
}

/// A switch.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum OnOff {
    On,
    Off,
}

/// The API a compatible endpoint speaks.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DialectArg {
    /// OpenAI Chat Completions (the default)
    Chat,
    /// OpenAI Responses
    Responses,
    /// Anthropic Messages
    Messages,
}

/// A period of usage.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum UsageRange {
    /// Since midnight
    Today,
    /// Today and the 6 days before
    #[usage(name = "7d")]
    Week,
    /// Today and the 29 days before
    #[usage(name = "30d")]
    Month,
    /// Everything recorded
    All,
}

impl UsageRange {
    pub fn word(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Week => "7d",
            Self::Month => "30d",
            Self::All => "all",
        }
    }
}

/// What usage is grouped by.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum UsageBy {
    Day,
    Model,
    Account,
    /// The machine that sent the requests
    Machine,
}

impl UsageBy {
    pub fn word(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Model => "model",
            Self::Account => "account",
            Self::Machine => "machine",
        }
    }
}

/// A period of requests.
#[derive(ValueEnum, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RequestsRange {
    /// Since midnight
    Today,
    /// Today and the 6 days before
    #[usage(name = "7d")]
    Week,
    /// Today and the 29 days before
    #[usage(name = "30d")]
    Month,
}

impl Slopmax {
    /// Whether this runs the proxy in the foreground, which logs each
    /// request.
    pub fn serves(&self) -> bool {
        matches!(
            self.command,
            Some(Command::Serve(_))
                | Some(Command::Proxy(Proxy {
                    command: Some(ProxyCommand::Serve(_)),
                    ..
                }))
        )
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    fn parses(line: &str) -> Slopmax {
        let words: Vec<&OsStr> = line.split_whitespace().map(OsStr::new).collect();
        Slopmax::parse_from(&words).unwrap_or_else(|e| panic!("{line}: {e:?}"))
    }

    #[test]
    fn every_command_parses_a_typical_invocation() {
        for line in [
            "",
            "setup --yes --import claude-code,codex --strategy fill-first --affinity off --agents none",
            "init --hub workstation --hub-key sm-x --key-name laptop --yes",
            "setup --find-hub",
            "status --refresh --json",
            "status -w",
            "dashboard --no-browser",
            "login claude --label work",
            "login codex --device --no-browser",
            "login compat --url http://localhost:11434/v1 --dialect responses --models qwen3,llama4",
            "account",
            "account ls --json",
            "account add grok",
            "account import cliproxyapi --adopt",
            "account use 2",
            "account use --auto",
            "account rename 1 work",
            "account priority work -1",
            "account order 3 1",
            "account order",
            "account enable 1",
            "account disable work",
            "account check me@x.dev",
            "account redeem 3 --yes",
            "account adopt all",
            "account rm 2 -y",
            "accounts list",
            "usage 30d --by model --json",
            "usage",
            "requests 7d --failed --account 1 --model gpt-5 -n 5 --json",
            "run codex exec -c model=m hi",
            "run claude -- --help",
            "agent",
            "agent list --json",
            "agent connect claude",
            "agent disconnect codex",
            "agent run grok",
            "agent env claude",
            "proxy",
            "proxy status --json",
            "proxy start",
            "proxy stop",
            "proxy restart",
            "proxy logs -f -n 100",
            "proxy install",
            "proxy uninstall",
            "proxy serve",
            "serve",
            "config",
            "config strategy round-robin",
            "config --json",
            "key",
            "key list --json",
            "key add laptop --models gpt-*",
            "key rm laptop",
            "tailscale",
            "tailscale status --json",
            "tailscale on --port 7600 --user me@github,you@github --admin mac --loopback",
            "tailscale on --socket",
            "tailscale off",
            "tailscale user",
            "tailscale user add me@github you@github",
            "tailscale admins remove mac",
            "doctor --json",
            "notify",
            "notify test",
            "update --check",
            "completion fish",
            "completions zsh",
        ] {
            parses(line);
        }
    }

    #[test]
    fn values_reach_the_types() {
        let Some(Command::Run(run)) = parses("run codex exec -c model=m --help").command else {
            panic!()
        };
        assert_eq!(run.agent, AgentArg::Codex);
        assert_eq!(run.args, ["exec", "-c", "model=m", "--help"]);
        let Some(Command::Account(Account {
            command: Some(AccountCommand::Priority(p)),
            ..
        })) = parses("account priority 2 -3").command
        else {
            panic!()
        };
        assert_eq!(p.tier, -3);
        let Some(Command::Tailscale(Tailscale {
            command: Some(TailscaleCommand::On(on)),
            ..
        })) = parses("tailscale on --user a@github,b@github --user c@github").command
        else {
            panic!()
        };
        assert_eq!(on.user, ["a@github", "b@github", "c@github"]);
        let Some(Command::Usage(usage)) = parses("usage").command else {
            panic!()
        };
        assert_eq!((usage.range, usage.by), (UsageRange::Week, UsageBy::Day));
        assert!(parses("serve").serves() && parses("proxy serve").serves());
        assert!(!parses("proxy start").serves());
    }

    #[test]
    fn the_value_words_match_the_engine() {
        let agents: Vec<&str> = slopmax_core::agent::AGENTS.iter().map(|a| a.id()).collect();
        assert_eq!(
            [AgentArg::Claude, AgentArg::Codex, AgentArg::Grok].map(AgentArg::word),
            agents.as_slice()
        );
        let providers: Vec<&str> = slopmax_core::provider::ProviderId::ALL
            .iter()
            .map(|p| p.as_str())
            .collect();
        let ours = [
            ProviderArg::Claude,
            ProviderArg::Codex,
            ProviderArg::Grok,
            ProviderArg::Anthropic,
            ProviderArg::Openai,
            ProviderArg::Xai,
            ProviderArg::Compat,
        ]
        .map(ProviderArg::word);
        assert_eq!(ours, providers.as_slice());
        for strategy in [
            StrategyArg::ResetFirst,
            StrategyArg::FillFirst,
            StrategyArg::LeastUsed,
            StrategyArg::RoundRobin,
        ] {
            assert!(slopmax_core::config::Strategy::parse(strategy.word()).is_some());
        }
    }

    /// The command line as `docs/cli/slopmax.usage.kdl` records it, which
    /// the docs are generated from (`mise run cli-docs`). A change to the
    /// command line changes it: `SLOPMAX_BLESS=1 cargo test -p slopmax`
    /// writes it anew.
    #[test]
    fn the_usage_spec_is_checked_in() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/cli/slopmax.usage.kdl"
        );
        // Without its version, which every release changes.
        let spec: String = Slopmax::to_kdl()
            .lines()
            .filter(|line| !line.starts_with("version "))
            .map(|line| format!("{line}\n"))
            .collect();
        if std::env::var_os("SLOPMAX_BLESS").is_some() {
            std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
            std::fs::write(path, &spec).unwrap();
        }
        let saved = std::fs::read_to_string(path).unwrap_or_default();
        assert!(
            saved == spec,
            "docs/cli/slopmax.usage.kdl is out of date: run `SLOPMAX_BLESS=1 cargo test -p slopmax`, then `mise run cli-docs`"
        );
    }
}
