// @slopmax/core: the engine, as services and layers.
export {
  Account,
  Accounts,
  accountText,
  assignId,
  compareAccounts,
  Credential,
  findAccount,
  Identity,
  identityKey,
  Link,
  parseAccount,
  Tokens,
  withAssignedId,
} from "./accounts.ts"
export * as Agents from "./agents/index.ts"
export { type Agent, agents, AgentConfigInvalid, NothingToUndo, type WireSettings } from "./agents/index.ts"
export {
  Background,
  type BackgroundService,
  NotRunning,
  type SlopmaxClient,
  StartFailed,
  StopFailed,
} from "./background.ts"
export { DialRefused, type DialRoute } from "./dial.ts"
export { doctor, type DoctorOptions, type DoctorServices } from "./doctor.ts"
export { Events } from "./events.ts"
export {
  causeText,
  type Dirs,
  dirsFromEnv,
  FileError,
  type FileAction,
  Home,
  type Paths,
  pathsFor,
  prettyJson,
} from "./home.ts"
export { Ledger, monthFile, type WindowHolder, windowEndedRecords } from "./ledger.ts"
export {
  costLabel,
  history,
  left,
  rangeStart,
  summary,
  unusedValue,
  type ViewContext,
  windowsEnded,
} from "./ledger-views.ts"
export { AlreadyServing, Holder, type Liveness, Lock, LockTimeout, systemLiveness } from "./lock.ts"
export * as Log from "./log.ts"
export {
  CommandFailed,
  type CommandFailure,
  type Conditions,
  noConditions,
  Notifier,
  NotifyFailed,
  NotifyOff,
  nudges,
  tell,
  Told,
  type ToldSet,
  watch,
  WebhookFailed,
} from "./notifier.ts"
export { accepts, portHolder, portTaken } from "./port-holder.ts"
export * as PoolModel from "./pool.ts"
export {
  type AccountLapse,
  affinityOverride,
  CodexSeen,
  Health,
  Pick,
  type PickRequest,
  Pool,
  ResetList,
  type Routing,
  routingOf,
  SavedState,
  Session,
} from "./pool.ts"
export { Proxy } from "./proxy/forward.ts"
export { relayLayer } from "./proxy/socket.ts"
export { ListenFailed, Relay, type RelayShape, Server, type SocketServer, WebApp, type WebAppShape } from "./server.ts"
export { Assets, type Asset, type AssetsShape } from "./api/assets.ts"
export { ApiDoctorOptions, Shutdown } from "./api/handlers.ts"
export { CoreLive, type CoreServices, Daemon, type DaemonError } from "./daemon.ts"
/**
 * Bun's file system, paths, processes, stdio and terminal: the platform the
 * engine runs on, for the CLI's tests and build scripts, which may not reach
 * for Bun's platform layer themselves.
 */
export { BunServices as Platform } from "@effect/platform-bun"
export * as Browser from "./browser.ts"
export * as Importers from "./importers.ts"
export * as Providers from "./providers/index.ts"
export { costAt, costOf, planFee, type Pricing, pricingOf, type Rates, ratesFor, shares } from "./pricing.ts"
export { NoLimitResets, NotReady, Quota } from "./quota.ts"
export * as Router from "./router.ts"
export { type Ask, Plan, type Step, type Table } from "./router.ts"
export { accountView, buildReport, currentZone, offline as offlineReport, report, type ReportInput } from "./report.ts"
export {
  type EndpointOptions,
  type Grant,
  type HeaderInput,
  LoginFailed,
  type LoginOptions,
  LoginTimedOut,
  LoginUi,
  NeedsAgent,
  type Provider,
  ProviderFailed,
  providerOf,
  providers,
  ProviderUnauthorized,
  type Refusal,
  type Resets,
  signIn,
  type SocketHooks,
  StateMismatch,
  Verdict,
} from "./providers/index.ts"
export {
  applyGrant,
  CliProxyApiLogin,
  linkedTokens,
  makeRefresher,
  pollUsage,
  type Refresher,
  type RefreshStore,
  RefreshRevoked,
  RefreshTransient,
} from "./refresh.ts"
export {
  ExitFailed,
  launchdPlist,
  type ManagerKind,
  NoServiceManager,
  type ServiceManager,
  ServiceNotInstalled,
  type ServiceStatus,
  selfCommand,
  SpawnFailed,
  systemdUnit,
} from "./service.ts"
export {
  baseUrlOf,
  dashboardUrl,
  editContents,
  type Reloaded,
  type Running,
  schemaDocument,
  schemaStamp,
  SettingsService,
} from "./settings.ts"
export { bridge, type Bridge, SocksFailed, type SocksTarget } from "./socks.ts"
export {
  bypassesProxy,
  chooseProxy,
  isLoopback,
  parseNoProxy,
  parseProxyUrl,
  type ProxyTarget,
  ProxyUrlInvalid,
  rewriteOrigin,
  showProxy,
  TimedOut,
  TooLarge,
  trustedRoots,
  Unreachable,
  Upstream,
  type UpstreamRequest,
  type UpstreamSocket,
} from "./upstream.ts"
