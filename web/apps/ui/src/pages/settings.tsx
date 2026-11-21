// Settings: how the app looks, the proxy and its address, how new sessions
// find an account, limit resets, notifications, and the rest of the live
// settings, each saved to config.toml and applied at once.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type LiveKey, type NotifySettings, type SettingsView, strategySummaries } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronDown, Copy, TriangleAlert } from "lucide-react"
import { useId } from "react"
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
  shownReportAtom,
  testNotifications,
  unansweredAtom,
  zone,
} from "../atoms.ts"
import { Label, Loaded, Panel, Section, SettingRow, Skeleton } from "../components/parts.tsx"
import { Choices } from "../components/choices.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Stepper } from "../components/stepper.tsx"
import { Alert, AlertTitle } from "../components/ui/alert.tsx"
import { Button } from "../components/ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../components/ui/input-group.tsx"
import { Switch } from "../components/ui/switch.tsx"
import type { Appearance } from "../host.ts"
import { dateTime } from "../view/asks.ts"
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

function ToggleSetting({
  title,
  detail,
  checked,
  onChange,
}: {
  readonly title: string
  readonly detail: string
  readonly checked: boolean
  readonly onChange: (value: boolean) => void
}) {
  const detailId = useId()
  return (
    <SettingRow title={title} detail={detail} detailId={detailId}>
      <Switch aria-label={title} aria-describedby={detailId} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  )
}

function AppearanceSection() {
  const prefs = useAtomValue(prefsAtom)
  const save = useAtomSet(savePrefs)
  return (
    <Section title="On this browser">
      <Panel>
        <SettingRow title="Theme">
          <Segmented
            label="Theme"
            value={prefs.appearance}
            options={appearances}
            onChange={(appearance) => save({ appearance })}
          />
        </SettingRow>
        <ToggleSetting
          title="Hide email addresses"
          detail="Mask email addresses when sharing your screen."
          checked={prefs.hideEmails}
          onChange={(hideEmails) => save({ hideEmails })}
        />
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
    <Section title="Proxy">
      <Panel>
        <SettingRow title="Status">
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

function NotificationsSection({ notify }: { readonly notify: NotifySettings }) {
  const permission = AsyncResult.getOrElse(useAtomValue(permissionAtom), () => "unsupported" as const)
  const ask = useAtomSet(askNotifications)
  const test = useAtomSet(testNotifications)
  const detail = "Get a reminder before a limit reset expires or a week ends with quota left."
  const destinations = [
    notify.webhook === undefined ? undefined : "Webhook",
    notify.command === undefined ? undefined : "Command",
  ].filter(Boolean)
  return (
    <Section title="Quota reminders">
      <Panel>
        <SettingRow
          title="Browser notifications"
          detail={
            permission === "unsupported"
              ? "This browser cannot show notifications."
              : permission === "denied"
                ? "Notifications are blocked. Allow them in your browser’s site settings."
                : detail
          }
        >
          {permission === "granted" ? (
            <Label tone="good" text="On in this browser" raw />
          ) : permission === "default" ? (
            <Button variant="outline" onClick={() => ask()}>
              Notify me
            </Button>
          ) : undefined}
        </SettingRow>
        {destinations.length === 0 ? (
          <SettingRow title="Webhook and command" detail="Configure delivery in config.toml." />
        ) : (
          <SettingRow title="Webhook and command" detail={`${destinations.join(" and ")} configured in config.toml.`}>
            <Button variant="outline" onClick={() => test()}>
              Send a test notice
            </Button>
          </SettingRow>
        )}
      </Panel>
    </Section>
  )
}

function LiveSections() {
  const settings = useAtomValue(settingsAtom)
  const again = useAtomRefresh(settingsAtom)
  const change = useAtomSet(changeSettings)
  return (
    <Loaded result={settings} title="Could not read the settings" loading={<Skeleton lines={6} />} onRetry={again}>
      {(view) => {
        const s = view.settings
        const restart = restartLine(view)
        const currentStrategy = view.strategies.find(({ id }) => id === s.strategy)
        const strategySummary = currentStrategy?.summary ?? strategySummaries[s.strategy]
        return (
          <>
            {restart !== undefined && (
              <Alert role="note" variant="warning">
                <TriangleAlert />
                <AlertTitle>{restart}</AlertTitle>
              </Alert>
            )}
            <Section title="Routing">
              <Panel>
                <Collapsible>
                  <SettingRow
                    title="Routing strategy"
                    detail={
                      <>
                        <span className="block font-medium text-foreground">{strategyTitle(s.strategy)}</span>
                        {strategyDetail(strategySummary)}
                      </>
                    }
                  >
                    <CollapsibleTrigger render={<Button variant="outline" className="group" />}>
                      Change strategy
                      <ChevronDown aria-hidden data-icon="inline-end" className="group-data-panel-open:rotate-180" />
                    </CollapsibleTrigger>
                  </SettingRow>
                  <CollapsibleContent>
                    <div className="border-t">
                      <Choices
                        label="Routing strategy"
                        value={s.strategy}
                        onChange={(strategy) => change({ strategy })}
                        options={view.strategies.map((strategy) => ({
                          value: strategy.id,
                          title: strategyTitle(strategy.id),
                          detail: strategyDetail(strategy.summary),
                          ...(strategy.id === "fill-first" ? { tag: "default" } : {}),
                        }))}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
                <ToggleSetting
                  title="Keep sessions on one account"
                  detail={affinityDetail}
                  checked={s.sessionAffinity}
                  onChange={(sessionAffinity) => change({ sessionAffinity })}
                />
                {view.live.some(({ name }) => name === "paidOverflow") && (
                  <ToggleSetting
                    title="Overflow to API keys"
                    detail="Use API keys when a subscription pool runs out of quota. These requests can incur charges."
                    checked={s.paidOverflow}
                    onChange={(paidOverflow) => change({ paidOverflow })}
                  />
                )}
              </Panel>
              <p className="text-xs text-muted-foreground">Proxy changes apply immediately and save to config.toml.</p>
            </Section>
            <Section title="Automatic limit resets">
              <Panel>
                <ToggleSetting
                  title="Redeem expiring resets"
                  detail={redeemExpiringDetail}
                  checked={s.redeemExpiring}
                  onChange={(redeemExpiring) => change({ redeemExpiring })}
                />
                <ToggleSetting
                  title="Redeem when all accounts are limited"
                  detail={redeemExhaustedDetail}
                  checked={s.redeemWhenExhausted}
                  onChange={(redeemWhenExhausted) => change({ redeemWhenExhausted })}
                />
              </Panel>
            </Section>
            <NotificationsSection notify={s.notify} />
          </>
        )
      }}
    </Loaded>
  )
}

function AdvancedSection({ view }: { readonly view: SettingsView }) {
  const change = useAtomSet(changeSettings)
  const set = (name: LiveKey, value: boolean | number) => Option.map(livePatch(name, value), change)
  return (
    <Section title="Advanced">
      <Panel>
        <Collapsible>
          <SettingRow title="Technical settings" detail="Session timeout, polling, sign-ins and transport.">
            <CollapsibleTrigger render={<Button variant="outline" className="group" />}>
              View settings
              <ChevronDown aria-hidden data-icon="inline-end" className="group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
          </SettingRow>
          <CollapsibleContent>
            <div className="border-t">
              <p className="px-4 py-3 text-xs text-muted-foreground">{affinityHeader}</p>
              {advancedRows(view).map((row) =>
                row._tag === "Switch" ? (
                  <ToggleSetting
                    key={row.name}
                    title={row.title}
                    detail={row.detail}
                    checked={row.on}
                    onChange={(on) => set(row.name, on)}
                  />
                ) : (
                  <SettingRow key={row.name} title={row.title} detail={row.detail}>
                    <Stepper
                      title={row.title}
                      value={row.shown}
                      onLess={row.less === undefined ? undefined : () => set(row.name, row.less ?? row.value)}
                      onMore={row.more === undefined ? undefined : () => set(row.name, row.more ?? row.value)}
                    />
                  </SettingRow>
                ),
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Panel>
    </Section>
  )
}

export function SettingsPage() {
  const settings = useAtomValue(settingsAtom)
  const view = Option.getOrUndefined(AsyncResult.value(settings))
  const report = Option.getOrUndefined(useAtomValue(shownReportAtom))
  const readOnly = useAtomValue(readOnlyAtom)
  const unanswered = useAtomValue(unansweredAtom)
  const waiting = cannotChange(unanswered, readOnly)
  return (
    <div className="flex w-full max-w-3xl flex-col gap-5 sm:gap-7">
      {waiting === undefined ? (
        // Running, or still finding out: the settings show as soon as the proxy answers for them.
        <LiveSections />
      ) : (
        <Section title="Routing">
          <p className="text-sm text-muted-foreground">
            {readOnly ? (
              "Proxy settings are changed on the hub, or from a machine that may manage it."
            ) : (
              <>
                To change proxy settings, run <code className="font-mono">slopmax config</code> on the machine running
                slopmax.
              </>
            )}
          </p>
          {report !== undefined && (
            <Panel>
              <SettingRow
                title="Routing strategy"
                detail={
                  <>
                    <span className="block font-medium text-foreground">{strategyTitle(report.strategy)}</span>
                    {strategyDetail(strategySummaries[report.strategy])}
                    {(unanswered || !report.live) && (
                      <span className="mt-1 block text-xs">Last reported {dateTime(report.generatedAt, zone)}</span>
                    )}
                  </>
                }
              />
            </Panel>
          )}
        </Section>
      )}
      <AppearanceSection />
      {waiting === undefined && view !== undefined && <AdvancedSection view={view} />}
      <ProxySection listen={view?.settings.listen} />
    </div>
  )
}
