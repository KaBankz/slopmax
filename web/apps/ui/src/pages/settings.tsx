// Settings: how the app looks, the proxy and its address, how new sessions
// find an account, limit resets, notifications, and the rest of the live
// settings, each saved to config.json and applied at once.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { LiveKey } from "@slopmax/client"
import type { Appearance } from "@slopmax/client/desktop"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Copy, ExternalLink, TriangleAlert } from "lucide-react"
import { hostAtom } from "../api.ts"
import {
  askNotifications,
  changeSettings,
  copy,
  dashboardUrl,
  openExternal,
  permissionAtom,
  prefsAtom,
  proxyAction,
  proxyAtom,
  proxyStatusAtom,
  readOnlyAtom,
  savePrefs,
  serviceAction,
  serviceAtom,
  settingsAtom,
  testNotifications,
  unansweredAtom,
} from "../atoms.ts"
import { Empty, Label, Loaded, Panel, Section, SettingRow, Skeleton } from "../components/parts.tsx"
import { Choices } from "../components/choices.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Stepper } from "../components/stepper.tsx"
import { Alert, AlertTitle } from "../components/ui/alert.tsx"
import { Button } from "../components/ui/button.tsx"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../components/ui/input-group.tsx"
import { Switch } from "../components/ui/switch.tsx"
import { cannotChange, loginService } from "../view/live.ts"
import { advancedRows, livePatch, restartLine } from "../view/settings.ts"
import {
  affinityDetail,
  affinityHeader,
  redeemExhaustedDetail,
  redeemExpiringDetail,
  strategyDetail,
  strategyTitle,
} from "../view/words.ts"

const appearances: ReadonlyArray<{ readonly value: Appearance; readonly title: string }> = [
  { value: "system", title: "System" },
  { value: "light", title: "Light" },
  { value: "dark", title: "Dark" },
]

function AppearanceSection() {
  const prefs = useAtomValue(prefsAtom)
  const save = useAtomSet(savePrefs)
  return (
    <Section title="Appearance">
      <Panel>
        <SettingRow title="Theme" detail="Follow the system, or keep to light or dark.">
          <Segmented
            label="Theme"
            value={prefs.appearance}
            options={appearances}
            onChange={(appearance) => save({ appearance })}
          />
        </SettingRow>
        <SettingRow
          title="Hide email addresses"
          detail="Mask every address the dashboard shows, as a•••@s•••.dev, for screen sharing and streams."
        >
          <Switch
            aria-label="Hide email addresses"
            checked={prefs.hideEmails}
            onCheckedChange={(hideEmails: boolean) => save({ hideEmails })}
          />
        </SettingRow>
      </Panel>
    </Section>
  )
}

function ProxySection({ listen }: { readonly listen: string | undefined }) {
  const host = useAtomValue(hostAtom)
  const proxy = useAtomValue(proxyAtom)
  const service = useAtomValue(serviceAtom)
  const act = useAtomSet(proxyAction)
  const install = useAtomSet(serviceAction)
  const copyText = useAtomSet(copy)
  const open = useAtomSet(openExternal)
  const desktop = Option.isSome(host) && host.value.kind === "desktop"
  const address =
    listen === undefined ? Option.match(host, { onNone: () => "", onSome: (h) => h.origin }) : `http://${listen}`
  const status = useAtomValue(proxyStatusAtom)
  const running = proxy._tag === "Running"
  const login = loginService(Option.getOrUndefined(AsyncResult.getOrElse(service, () => Option.none())))
  return (
    <Section title="Proxy">
      <Panel>
        <SettingRow title="Status" detail="slopmax serves your agents while it runs.">
          <Label tone={status.tone} text={status.text} raw />
          {desktop &&
            (running ? (
              <Button variant="outline" onClick={() => act("stop")}>
                Stop
              </Button>
            ) : proxy._tag === "OtherVersion" ? (
              <Button onClick={() => act("restart")}>Restart</Button>
            ) : (
              <Button disabled={proxy._tag === "Starting"} onClick={() => act("start")}>
                Start
              </Button>
            ))}
        </SettingRow>
        <SettingRow title="Address for agents" detail="Where an agent sends its requests.">
          <InputGroup className="w-64">
            <InputGroupInput readOnly aria-label="Address for agents" value={address} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => copyText({ text: address, said: `Copied ${address}` })}>
                <Copy />
                Copy
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </SettingRow>
        {desktop && (
          <>
            <SettingRow title="Web dashboard" detail="The same at a glance, in your browser.">
              <Button
                variant="outline"
                disabled={!running || listen === undefined}
                onClick={() => open(dashboardUrl(listen ?? ""))}
              >
                <ExternalLink />
                Open in browser
              </Button>
            </SettingRow>
            <SettingRow title="Start at login" detail={login.detail}>
              <Switch
                aria-label="Start at login"
                checked={login.on}
                disabled={!login.available}
                onCheckedChange={(on) => install(on ? "install" : "uninstall")}
              />
            </SettingRow>
          </>
        )}
      </Panel>
    </Section>
  )
}

function NotificationsSection() {
  const host = useAtomValue(hostAtom)
  const prefs = useAtomValue(prefsAtom)
  const permission = AsyncResult.getOrElse(useAtomValue(permissionAtom), () => "unsupported" as const)
  const save = useAtomSet(savePrefs)
  const ask = useAtomSet(askNotifications)
  const test = useAtomSet(testNotifications)
  const desktop = Option.isSome(host) && host.value.kind === "desktop"
  const detail = "When a limit reset is about to lapse unredeemed, or a week is about to reset with quota to spare."
  return (
    <Section title="Notifications">
      <Panel>
        {desktop ? (
          <SettingRow title="Notify me" detail={detail}>
            <Switch
              aria-label="Notifications"
              checked={prefs.notifications}
              onCheckedChange={(notifications) => save({ notifications })}
            />
          </SettingRow>
        ) : (
          <SettingRow
            title="Notify me"
            detail={
              permission === "unsupported"
                ? "This browser cannot show notifications."
                : permission === "denied"
                  ? "This browser blocks notifications from slopmax; allow them in its site settings."
                  : detail
            }
          >
            {permission === "granted" ? (
              <Label tone="good" text="On in this browser" raw />
            ) : (
              <Button variant="outline" disabled={permission !== "default"} onClick={() => ask()}>
                Notify me
              </Button>
            )}
          </SettingRow>
        )}
        <SettingRow title="Webhook and command" detail="Where else notices go, as config.json's notify sets it.">
          <Button variant="outline" onClick={() => test()}>
            Send a test notice
          </Button>
        </SettingRow>
      </Panel>
    </Section>
  )
}

function LiveSections() {
  const settings = useAtomValue(settingsAtom)
  const again = useAtomRefresh(settingsAtom)
  const change = useAtomSet(changeSettings)
  const set = (name: LiveKey, value: boolean | number) => Option.map(livePatch(name, value), change)
  return (
    <Loaded result={settings} title="Could not read the settings" loading={<Skeleton lines={6} />} onRetry={again}>
      {(view) => {
        const s = view.settings
        const restart = restartLine(view)
        return (
          <>
            {restart !== undefined && (
              <Alert role="note" variant="warning">
                <TriangleAlert />
                <AlertTitle>{restart}</AlertTitle>
              </Alert>
            )}
            <Section title="Routing">
              <div className="flex flex-col gap-2">
                <Panel>
                  <Choices
                    label="Strategy"
                    value={s.strategy}
                    onChange={(strategy) => change({ strategy })}
                    options={view.strategies.map((strategy) => ({
                      value: strategy.id,
                      title: strategyTitle(strategy.id),
                      detail: strategyDetail(strategy.summary),
                      ...(strategy.id === "fill-first" ? { tag: "default" } : {}),
                    }))}
                  />
                  <SettingRow title="Session affinity" detail={affinityDetail}>
                    <Switch
                      aria-label="Session affinity"
                      checked={s.sessionAffinity}
                      onCheckedChange={(sessionAffinity) => change({ sessionAffinity })}
                    />
                  </SettingRow>
                </Panel>
                <p className="text-xs text-muted-foreground">{affinityHeader}</p>
              </div>
            </Section>
            <Section title="Limit resets">
              <Panel>
                <SettingRow title="When one would expire unused" detail={redeemExpiringDetail}>
                  <Switch
                    aria-label="When one would expire unused"
                    checked={s.redeemExpiring}
                    onCheckedChange={(redeemExpiring) => change({ redeemExpiring })}
                  />
                </SettingRow>
                <SettingRow title="When every account is spent" detail={redeemExhaustedDetail}>
                  <Switch
                    aria-label="When every account is spent"
                    checked={s.redeemWhenExhausted}
                    onCheckedChange={(redeemWhenExhausted) => change({ redeemWhenExhausted })}
                  />
                </SettingRow>
              </Panel>
            </Section>
            <NotificationsSection />
            <Section title="Advanced">
              <div className="flex flex-col gap-2">
                <Panel>
                  {advancedRows(view).map((row) => (
                    <SettingRow key={row.name} title={row.title} detail={row.detail}>
                      {row._tag === "Switch" ? (
                        <Switch aria-label={row.title} checked={row.on} onCheckedChange={(on) => set(row.name, on)} />
                      ) : (
                        <Stepper
                          title={row.title}
                          value={row.shown}
                          onLess={row.less === undefined ? undefined : () => set(row.name, row.less ?? row.value)}
                          onMore={row.more === undefined ? undefined : () => set(row.name, row.more ?? row.value)}
                        />
                      )}
                    </SettingRow>
                  ))}
                </Panel>
                <p className="text-xs text-muted-foreground">
                  Each is saved to config.json and applied at once; slopmax config changes them too.
                </p>
              </div>
            </Section>
          </>
        )
      }}
    </Loaded>
  )
}

export function SettingsPage() {
  const settings = useAtomValue(settingsAtom)
  const proxy = useAtomValue(proxyAtom)
  const listen = Option.getOrUndefined(Option.map(AsyncResult.value(settings), (view) => view.settings.listen))
  const readOnly = useAtomValue(readOnlyAtom)
  const waiting = cannotChange(proxy, "change settings", useAtomValue(unansweredAtom), readOnly)
  return (
    <>
      <AppearanceSection />
      <ProxySection listen={listen} />
      {waiting === undefined ? (
        // Running, or still finding out: the settings show as soon as the proxy answers for them.
        <LiveSections />
      ) : (
        <Empty
          title={waiting}
          detail={
            readOnly
              ? "Routing, limit resets and the rest are changed on the hub, or from a machine that may manage it."
              : "Routing, limit resets and the rest are changed through the running proxy; slopmax config changes them from a terminal."
          }
        />
      )}
    </>
  )
}
