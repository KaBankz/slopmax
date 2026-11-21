// Settings: how the app looks, the proxy and its address, how new sessions
// find an account, limit resets, notifications, and the rest of the live
// settings, each saved to config.toml and applied at once.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { LiveKey } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Copy, TriangleAlert } from "lucide-react"
import { hostAtom } from "../api.ts"
import {
  askNotifications,
  changeSettings,
  copy,
  permissionAtom,
  prefsAtom,
  proxyStatusAtom,
  readOnlyAtom,
  savePrefs,
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
import type { Appearance } from "../host.ts"
import { cannotChange } from "../view/live.ts"
import { advancedRows, livePatch, restartLine } from "../view/settings.ts"
import {
  affinityDetail,
  affinityHeader,
  redeemExhaustedDetail,
  redeemExpiringDetail,
  strategyDetail,
  strategyTitle,
} from "../view/words.ts"

const appearances: ReadonlyArray<{
  readonly value: Appearance
  readonly title: string
}> = [
  { value: "system", title: "System" },
  { value: "light", title: "Light" },
  { value: "dark", title: "Dark" },
]

function AppearanceSection() {
  const prefs = useAtomValue(prefsAtom)
  const save = useAtomSet(savePrefs)
  return (
    <Section title="On this browser" layout="split">
      <Panel>
        <SettingRow title="Theme" detail="Choose the dashboard theme for this browser.">
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
  const copyText = useAtomSet(copy)
  const address =
    listen === undefined ? Option.match(host, { onNone: () => "", onSome: (h) => h.origin }) : `http://${listen}`
  const status = useAtomValue(proxyStatusAtom)
  return (
    <Section title="Proxy" layout="split">
      <Panel>
        <SettingRow title="Status" detail="slopmax serves your agents while it runs.">
          <Label tone={status.tone} text={status.text} raw />
        </SettingRow>
        <SettingRow title="Address for agents" detail="Where an agent sends its requests.">
          <InputGroup className="w-72 max-w-full">
            <InputGroupInput readOnly aria-label="Address for agents" value={address} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => copyText({ text: address, said: `Copied ${address}` })}>
                <Copy />
                Copy
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </SettingRow>
      </Panel>
    </Section>
  )
}

function NotificationsSection() {
  const permission = AsyncResult.getOrElse(useAtomValue(permissionAtom), () => "unsupported" as const)
  const ask = useAtomSet(askNotifications)
  const test = useAtomSet(testNotifications)
  const detail = "When a limit reset is about to lapse unredeemed, or a week is about to reset with quota to spare."
  return (
    <Section title="Quota reminders" layout="split">
      <Panel>
        <SettingRow
          title="Browser notifications"
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
        <SettingRow title="Webhook and command" detail="Where else notices go, as config.toml's notify sets it.">
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
            <Section title="Routing" layout="split">
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
            <Section title="Limit resets" layout="split">
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
            <Section title="Advanced" layout="split">
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
                  Each is saved to config.toml and applied at once; slopmax config changes them too.
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
  const listen = Option.getOrUndefined(Option.map(AsyncResult.value(settings), (view) => view.settings.listen))
  const readOnly = useAtomValue(readOnlyAtom)
  const waiting = cannotChange(useAtomValue(unansweredAtom), readOnly)
  return (
    <>
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
      <AppearanceSection />
      <ProxySection listen={listen} />
    </>
  )
}
