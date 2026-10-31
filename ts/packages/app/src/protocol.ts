// What the desktop shell and its engine say to each other. Electron's main
// process (the shell: window, tray, notifications) runs `slopmax app-host`
// (the engine: `App`) and talks to it over its stdin and stdout, one JSON
// message per line.
//
// The host speaks first, with `Hello` and the protocol's version, then a
// `View` for every change worth redrawing: everything the window, the menu
// bar panel, and the tray draw, worded and toned, with each control's
// label, whether it can be used, and the request it sends. The shell sends
// `Request`s, one per action, each answered by a `Done` once its work has
// finished; how it went shows in the next `View`'s notice. Notifications
// arrive as `Notify`, and a sign-in's prompts as `Prompt`.
//
// This module imports only `effect`, so the shell's Node process can use it
// without the engine.
import { Result, Schema } from "effect"

/** Bumped whenever a message changes shape. */
export const VERSION = 1

// ---- what the view model is made of ---------------------------------------------

/** How a front end colors a window's use or an account's condition. */
export const Tone = Schema.Literals(["good", "muted", "accent", "warn", "bad"])
export type Tone = typeof Tone.Type

export const Label = Schema.Struct({ text: Schema.String, tone: Tone })
export type Label = typeof Label.Type

export const Pace = Schema.Struct({
  /** How far through the window it is, from 0 to 1: where an even spend would have reached. */
  elapsed: Schema.Number,
  /** `On pace`, `Runs out ~14:10`, or `18% in reserve`. */
  label: Label,
})

/** A usage window as a bar. */
export const Gauge = Schema.Struct({
  /** How full, from 0 to 1. */
  fraction: Schema.Number,
  /** `42%`. */
  percent: Schema.String,
  /** `2h05m`, when it has use to reset. */
  resetsIn: Schema.optional(Schema.String),
  /** `22:59`, `Wed 20:27`, or `Nov 3`, on this machine's clock. */
  resetsAt: Schema.optional(Schema.String),
  tone: Tone,
  pace: Schema.optional(Pace),
})
export type Gauge = typeof Gauge.Type

/** One account's segment of a pool's bar. */
export const Share = Schema.Struct({
  weight: Schema.Number,
  fraction: Schema.Number,
  tone: Tone,
  /** Not serving: disabled, or signed out. */
  idle: Schema.Boolean,
})

export const Overview = Schema.Struct({ title: Schema.String, gauge: Gauge, shares: Schema.Array(Share) })

export const CreditLine = Schema.Struct({
  /** `Expires Oct 9`, or `Does not expire`. */
  expires: Schema.String,
  /** `Expires in 2d23h · Oct 9`. */
  line: Schema.String,
  /** `in 2d23h`. */
  left: Schema.optional(Schema.String),
  /** `Granted Sep 21`. */
  granted: Schema.optional(Schema.String),
  /** Warn once it expires within 72 hours. */
  tone: Tone,
})

// ---- what the shell asks for --------------------------------------------------------

/** A setting the window changes while the proxy runs. */
export const Setting = Schema.TaggedUnion({
  Strategy: { value: Schema.Literals(["reset-first", "fill-first", "least-used", "round-robin"]) },
  SessionAffinity: { value: Schema.Boolean },
  RedeemExpiringCredits: { value: Schema.Boolean },
  RedeemWhenExhausted: { value: Schema.Boolean },
  SessionTtlMins: { value: Schema.Int },
  WarmWindows: { value: Schema.Boolean },
  PaidOverflow: { value: Schema.Boolean },
  PollMins: { value: Schema.Int },
})
export type Setting = typeof Setting.Type

/** The ledger's ranges. */
export const Range = Schema.Literals(["today", "week", "month"])

/** The providers, by id. */
export const Provider = Schema.Literals(["claude", "codex", "anthropic", "openai", "xai", "compat"])

/** The formats a compatible endpoint can speak. */
export const Dialect = Schema.Literals(["chat", "responses", "messages"])

/** Every action the engine takes, as `App` names them. */
export const Action = Schema.TaggedUnion({
  SignIn: { provider: Provider },
  AddKey: { provider: Provider, key: Schema.String },
  AddEndpoint: {
    url: Schema.String,
    dialect: Dialect,
    models: Schema.Array(Schema.String),
    key: Schema.String,
    label: Schema.optional(Schema.String),
  },
  AddClientKey: { name: Schema.String, models: Schema.Array(Schema.String) },
  RevokeKey: { name: Schema.String },
  DismissNewKey: {},
  CheckSetup: {},
  Own: { account: Schema.String },
  /** The answer to a sign-in's prompt: the address a browser elsewhere ended on. */
  Paste: { address: Schema.String },
  CancelSignIn: {},
  Import: {},
  Pin: { account: Schema.String },
  UnpinAll: {},
  SetDisabled: { account: Schema.String, disabled: Schema.Boolean },
  SetPriority: { account: Schema.String, priority: Schema.Int },
  Rename: { account: Schema.String, label: Schema.optional(Schema.String) },
  Remove: { account: Schema.String },
  ConnectAgent: { agent: Schema.String },
  DisconnectAgent: { agent: Schema.String },
  StartProxy: {},
  StopProxy: {},
  InstallService: {},
  UninstallService: {},
  Redeem: { account: Schema.String },
  Set: { setting: Setting },
  SetNotifications: { on: Schema.Boolean },
  Refresh: {},
  LoadHistory: { range: Range },
  LoadToday: {},
  OpenDashboard: {},
  DismissNotice: {},
  /**
   * The window or the menu bar panel opened (`shown`) or every one closed:
   * while one shows, the view follows the clock every second, for its
   * countdowns.
   */
  Window: { shown: Schema.Boolean },
})
export type Action = typeof Action.Type

/** One action, numbered by the shell; its `Done` carries the number back. */
export const Request = Schema.Struct({ id: Schema.Int, action: Action })
export type Request = typeof Request.Type

// ---- the view model ---------------------------------------------------------------

/** An item of an account's `…` menu: a choice, a label, or a rule. */
export const MenuItem = Schema.TaggedUnion({
  /**
   * `key` names it (`pin`, `unpin`, `toggle`, `raise`, `lower`, `own`,
   * `redeem`); `action` is the request it sends. `redeem` has none: it
   * opens the account's limit resets to confirm there.
   */
  Choice: { key: Schema.String, label: Schema.String, enabled: Schema.Boolean, action: Schema.optional(Action) },
  Caption: { text: Schema.String },
  Separator: {},
})
export type MenuItem = typeof MenuItem.Type

/** An account's reset credits, and redeeming one. */
export const Credits = Schema.Struct({
  /** `2 limit resets`. */
  title: Schema.String,
  /** Soonest to expire first; empty until slopmax has listed them (`Listing them…`). */
  credits: Schema.Array(CreditLine),
  /** The windows one clears: `5-hour and weekly`. */
  clears: Schema.String,
  /** Why none can be redeemed now, from the account alone. */
  held: Schema.optional(Schema.String),
  /** Whether one is being redeemed now (`Redeeming…`). */
  redeeming: Schema.Boolean,
  /** Why the window cannot redeem one now: `held`, or that the proxy is not running. */
  reason: Schema.optional(Schema.String),
  /** Whether `Redeem…` can be pressed. */
  canRedeem: Schema.Boolean,
  /** The request that redeems one, once confirmed. */
  redeem: Action,
  /** When slopmax redeems them by itself, as config.toml has it. */
  policy: Schema.optional(Schema.String),
})

export const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The plan, or how a key is billed; empty for none. */
  plan: Schema.String,
  /** A gauge per column of the group's `limits`, or null where the account reports no such window. */
  limits: Schema.Array(Schema.NullOr(Gauge)),
  /** Per column: whether the cell fades (the account is off, or another of its windows is full). */
  faded: Schema.Array(Schema.Boolean),
  status: Label,
  notes: Schema.Array(Label),
  pinned: Schema.Boolean,
  disabled: Schema.Boolean,
  priority: Schema.Int,
  /** `used 3m ago`. */
  lastUsed: Schema.optional(Schema.String),
  credits: Schema.optional(Credits),
  /** Whether a new session would go to it now (`Next`). */
  next: Schema.Boolean,
  /** The tool whose copy of its login slopmax follows. */
  follows: Schema.optional(Schema.String),
  menu: Schema.Array(MenuItem),
})
export type Row = typeof Row.Type

/** One provider's accounts. */
export const Group = Schema.Struct({
  provider: Provider,
  title: Schema.String,
  /** Whether its accounts have usage windows; keys bill per token. */
  subscription: Schema.Boolean,
  /** The column titles: `5-hour`, `Weekly`, `Weekly · Fable`. */
  limits: Schema.Array(Schema.String),
  accounts: Schema.Array(Row),
  /** Each window across the working accounts. */
  overview: Schema.Array(Overview),
  working: Schema.Int,
  weighted: Schema.Boolean,
  /** `weighted by plan`, or `average of accounts`. */
  basis: Schema.String,
  /** The pool bar's tooltip. */
  segmentsTip: Schema.String,
  /** `Across 3 accounts, average of accounts`, and the rest out of service when some are. */
  across: Schema.String,
  /** `2 of 3 ready`. */
  ready: Schema.String,
  /** `4 limit resets · the next expires in 2d23h`. */
  credits: Schema.optional(Schema.String),
  next: Label,
  nextShort: Label,
  /** Whether any account is pinned (`Let slopmax choose` shows). */
  pinned: Schema.Boolean,
  /** For the menu bar panel: enabled accounts out of service that `attention` does not name. */
  troubled: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, status: Label })),
})
export type Group = typeof Group.Type

/** Something that wants a look, and the button that does something about it. */
export const Attention = Schema.Struct({
  provider: Provider,
  account: Schema.String,
  text: Schema.String,
  who: Schema.String,
  what: Schema.String,
  tone: Tone,
  remedy: Schema.Literals(["SignIn", "Redeem", "Look"]),
  /** `Sign in…`, `Redeem…`, or `Show`. */
  button: Schema.String,
})

export const Status = Schema.Struct({
  headline: Schema.String,
  detail: Schema.optional(Schema.String),
  tone: Tone,
})

export const SignInView = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
  /** The address to open, show in full, and copy. */
  link: Schema.optional(Schema.String),
  /** A device code to enter. */
  code: Schema.optional(Schema.String),
  /** Notes while waiting, one per line. */
  notes: Schema.String,
})
export type SignInView = typeof SignInView.Type

/** A minutes setting stepped through fixed values. */
export const Stepper = Schema.Struct({
  value: Schema.Int,
  /** `45 min`, `2 h`, `1 day`, or `Off`. */
  text: Schema.String,
  /** What the down and up buttons set; absent, the button is inert. */
  down: Schema.optional(Schema.Int),
  up: Schema.optional(Schema.Int),
  detail: Schema.String,
})

export const View = Schema.Struct({
  proxy: Schema.Struct({
    state: Schema.Literals(["checking", "starting", "running", "stopped"]),
    version: Schema.optional(Schema.String),
    /** Where agents reach it. */
    address: Schema.String,
    running: Schema.Boolean,
    /** The header's line: `Running 0.3.0 at http://127.0.0.1:7567`. */
    line: Schema.String,
    /** The sidebar's foot: `Running 0.3.0`, `Starting…`, `Looking for the proxy…`, `Stopped`. */
    foot: Label,
    /** Settings' status: as the foot, but `Looking for it…`. */
    setting: Label,
    /** The menu bar panel's status line. */
    panel: Label,
    /** Settings' `Stop` (when running) or `Start`, and what it sends. */
    toggle: Schema.Struct({ label: Schema.String, primary: Schema.Boolean, action: Action }),
  }),
  /** The menu bar item's title: `Claude 42% · ChatGPT 18%`, `slopmax` until a report. */
  menuBar: Schema.String,
  /** Whether any report has come: before one, pages say they are looking for the proxy. */
  loaded: Schema.Boolean,
  /** How the accounts stand, once loaded. */
  status: Schema.optional(Status),
  attention: Schema.Array(Attention),
  /** `Reset first · sessions keep their account`. */
  routing: Schema.String,
  /** The sidebar's provider rows, in registry order: each with its account count, and its worst attention tone. */
  providers: Schema.Array(
    Schema.Struct({ provider: Provider, title: Schema.String, count: Schema.Int, dot: Schema.optional(Tone) }),
  ),
  groups: Schema.Array(Group),
  /** Whether `Refresh usage` can be pressed. */
  canRefresh: Schema.Boolean,
  /** Whether `Open in browser` (the dashboard) can be pressed. */
  canOpenDashboard: Schema.Boolean,
  notice: Schema.optional(Schema.Struct({ text: Schema.String, error: Schema.Boolean })),
  signIn: Schema.optional(SignInView),
  agents: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      /** `Goes through slopmax`, `Goes to …`, `Goes straight to its provider`. */
      line: Schema.String,
      /** `Connected` (good) or `Not connected` (muted). */
      state: Label,
      /** `Connect` or `Disconnect`, and what it sends. */
      button: Schema.Struct({ label: Schema.String, action: Action }),
    }),
  ),
  /** Start at login. */
  login: Schema.Struct({ on: Schema.Boolean, available: Schema.Boolean, detail: Schema.String, action: Action }),
  settings: Schema.Struct({
    strategies: Schema.Array(
      Schema.Struct({ title: Schema.String, detail: Schema.String, chosen: Schema.Boolean, action: Action }),
    ),
    affinity: Schema.Boolean,
    affinityDetail: Schema.String,
    affinityHeader: Schema.String,
    redeemExpiring: Schema.Boolean,
    redeemExpiringDetail: Schema.String,
    redeemExhausted: Schema.Boolean,
    redeemExhaustedDetail: Schema.String,
    sessionTtl: Stepper,
    poll: Stepper,
    warmWindows: Schema.Boolean,
    warmWindowsDetail: Schema.String,
    paidOverflow: Schema.Boolean,
    paidOverflowDetail: Schema.String,
    notifications: Schema.Boolean,
  }),
  /** The client keys in config.toml: each name, and `Any model` or its patterns joined. */
  keys: Schema.Array(Schema.Struct({ name: Schema.String, models: Schema.String })),
  /** A key just made, shown once. */
  newKey: Schema.optional(Schema.Struct({ name: Schema.String, key: Schema.String })),
  doctor: Schema.Struct({
    state: Schema.Literals(["not-run", "running", "done", "failed"]),
    /** Why it could not check, when it failed. */
    message: Schema.optional(Schema.String),
    /** Every finding in order; `section` on each section's first. */
    findings: Schema.Array(
      Schema.Struct({
        section: Schema.optional(Schema.String),
        text: Schema.String,
        tone: Tone,
        fix: Schema.optional(Schema.String),
      }),
    ),
    /** Whether `Check again` can be pressed. */
    canCheck: Schema.Boolean,
  }),
  /** The ranges, as the Usage page offers them. */
  ranges: Schema.Array(Schema.Struct({ range: Range, title: Schema.String })),
  /**
   * The ledger over the range last loaded, as `/slopmax/history` answers it,
   * with what weekly resets left unused, in a line.
   */
  history: Schema.optional(Schema.Struct({ range: Range, data: Schema.Json, left: Schema.String })),
  /** Today's, for the overview and the panel. */
  today: Schema.optional(Schema.Struct({ range: Range, data: Schema.Json, left: Schema.String })),
})
export type View = typeof View.Type

// ---- what the host says -------------------------------------------------------------

export const Event = Schema.TaggedUnion({
  /** The first message: the protocol's version, and slopmax's. */
  Hello: { protocol: Schema.Int, version: Schema.String },
  /** Everything to draw, whenever it changes. */
  View: { view: View },
  /** A notification to post; one posted again under `key` replaces the last. */
  Notify: { key: Schema.String, title: Schema.String, body: Schema.String },
  /** A sign-in's prompt as it changes, and none once it ends: what to open, enter, or paste. */
  Prompt: { signIn: Schema.optional(SignInView) },
  /** Request `id`'s work has finished; `error` when it could not be done at all. */
  Done: { id: Schema.Int, error: Schema.optional(Schema.String) },
  /** A line that is not a request this version knows. */
  Rejected: { error: Schema.String },
  /** The engine could not start; it exits after saying so. */
  Fatal: { message: Schema.String },
})
export type Event = typeof Event.Type

// ---- lines ------------------------------------------------------------------------

const EventLine = Schema.fromJsonString(Event)
const RequestLine = Schema.fromJsonString(Request)

const decodeEventLine = Schema.decodeUnknownResult(EventLine)
const decodeRequestLine = Schema.decodeUnknownResult(RequestLine)

const encodeEventLine = Schema.encodeResult(EventLine)

/** An event as one line of JSON, without its newline, or why it does not fit the protocol. */
export const encodeEvent = (event: Event): Result.Result<string, string> =>
  Result.mapError(encodeEventLine(event), (e) => e.message)

/** A request as one line of JSON, without its newline. */
export const encodeRequest: (request: Request) => string = Schema.encodeSync(RequestLine)

/** A line the host wrote, or why it is not an event. */
export const decodeEvent = (line: string): Result.Result<Event, string> =>
  Result.mapError(decodeEventLine(line), (e) => e.message)

/** A line the shell wrote, or why it is not a request. */
export const decodeRequest = (line: string): Result.Result<Request, string> =>
  Result.mapError(decodeRequestLine(line), (e) => e.message)
