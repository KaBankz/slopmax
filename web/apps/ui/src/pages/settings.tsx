// Settings: how the app looks, the proxy and its address, how new sessions
// find an account, limit resets, notifications, and the rest of the live
// settings, each saved to config.toml and applied at once.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type LiveKey, type NotifySettings, type SettingsView, type Strategy, strategySummaries } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronDown, Copy, TriangleAlert } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.tsx"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../components/ui/input-group.tsx"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "../components/ui/item.tsx"
import { Switch } from "../components/ui/switch.tsx"
import type { Appearance } from "../host.ts"
import { dateTime } from "../view/asks.ts"
import { cannotChange } from "../view/live.ts"
import { advancedRows, livePatch, restartLine } from "../view/settings.ts"
import {
  affinityDetail,
  affinityHeader,
  paidFallbackOff,
  paidFallbackOn,
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
    <SettingRow title={title} detail={detail} detailId={detailId} layout="fullDetail">
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
        <SettingRow title="Theme" layout="inline">
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
    <Section title="Proxy connection">
      <Panel>
        <SettingRow title="Status">
          <Label tone={status.tone} text={status.text} raw />
        </SettingRow>
        <SettingRow title="Proxy address">
          <InputGroup className="w-72 max-w-full">
            <InputGroupInput readOnly aria-label="Proxy address" value={address} />
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

function ReminderRows({ notify }: { readonly notify: NotifySettings }) {
  const permission = AsyncResult.getOrElse(useAtomValue(permissionAtom), () => "unsupported" as const)
  const ask = useAtomSet(askNotifications)
  const test = useAtomSet(testNotifications)
  const destinations = [
    notify.webhook === undefined ? undefined : "webhook",
    notify.command === undefined ? undefined : "command",
  ].filter(Boolean)
  return (
    <>
      <SettingRow
        title="Browser notifications"
        layout="fullDetail"
        detail={
          <>
            Expiring resets and unused weekly quota.
            {permission === "denied" && (
              <span className="block">Allow notifications in your browser’s site settings.</span>
            )}
          </>
        }
      >
        {permission === "granted" ? (
          <Label tone="good" text="On in this browser" raw />
        ) : permission === "default" ? (
          <Button variant="outline" onClick={() => ask()}>
            Notify me
          </Button>
        ) : permission === "denied" ? (
          <Label tone="warn" text="Blocked" raw />
        ) : (
          <Label tone="muted" text="Not supported" raw />
        )}
      </SettingRow>
      {destinations.length === 0 ? (
        <SettingRow
          title="Webhook or command"
          detail={
            <>
              Configure delivery under <code className="font-mono">[notify]</code> in{" "}
              <code className="font-mono">config.toml</code>.
            </>
          }
        />
      ) : (
        <SettingRow
          title="Webhook or command"
          detail={
            <>
              Configured in <code className="font-mono">config.toml</code> ({destinations.join(" and ")}).
            </>
          }
        >
          <Button variant="outline" onClick={() => test()}>
            Send a test notification
          </Button>
        </SettingRow>
      )}
    </>
  )
}

function StrategySummary({
  strategy,
  summary,
  action,
  reportedAt,
}: {
  readonly strategy: Strategy
  readonly summary: string
  readonly action?: ReactNode
  readonly reportedAt?: string | undefined
}) {
  return (
    <Item size="row" variant={action === undefined ? "default" : "setting-summary"}>
      <ItemContent className="min-w-0 basis-32">
        <span className="text-xs font-medium text-muted-foreground">Routing strategy</span>
        <ItemTitle>{strategyTitle(strategy)}</ItemTitle>
      </ItemContent>
      {action !== undefined && <ItemActions>{action}</ItemActions>}
      <ItemDescription className="basis-full">
        {strategyDetail(summary)}
        {reportedAt !== undefined && <span className="mt-1 block text-xs">Last reported {reportedAt}</span>}
      </ItemDescription>
    </Item>
  )
}

function StrategySetting({ view }: { readonly view: SettingsView }) {
  const change = useAtomSet(changeSettings)
  const [draft, setDraft] = useState<Strategy>()
  const active = view.settings.strategy
  const summary = view.strategies.find(({ id }) => id === active)?.summary ?? strategySummaries[active]
  return (
    <Dialog open={draft !== undefined} onOpenChange={(open) => setDraft(open ? active : undefined)}>
      <StrategySummary
        strategy={active}
        summary={summary}
        action={
          <DialogTrigger render={<Button variant="outline" size="pageAction" />} aria-label="Change strategy">
            Change
          </DialogTrigger>
        }
      />
      <DialogContent showCloseButton={false} size="wide">
        <DialogHeader>
          <DialogTitle>Change routing strategy</DialogTitle>
          <DialogDescription>How the proxy picks accounts.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <Panel>
            <Choices
              label="Routing strategy"
              value={draft ?? active}
              onChange={setDraft}
              options={view.strategies.map(({ id, summary: detail }) => ({
                value: id,
                title: strategyTitle(id),
                detail: strategyDetail(detail),
                tags: [
                  ...(id === active ? ["current" as const] : []),
                  ...(id === "fill-first" ? ["default" as const] : []),
                ],
              }))}
            />
          </Panel>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="pageAction" />}>Cancel</DialogClose>
          <Button
            size="pageAction"
            disabled={draft === undefined || draft === active}
            onClick={() => {
              if (draft === undefined || draft === active) return
              change({ strategy: draft })
              setDraft(undefined)
            }}
          >
            Apply strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                <StrategySetting view={view} />
                <ToggleSetting
                  title="Keep sessions on one account"
                  detail={affinityDetail}
                  checked={s.sessionAffinity}
                  onChange={(sessionAffinity) => change({ sessionAffinity })}
                />
                {view.live.some(({ name }) => name === "paidOverflow") && (
                  <ToggleSetting
                    title="Paid API fallback"
                    detail={`${paidFallbackOn} ${paidFallbackOff}`}
                    checked={s.paidOverflow}
                    onChange={(paidOverflow) => change({ paidOverflow })}
                  />
                )}
              </Panel>
            </Section>
            <Section title="Limits and reminders">
              <Panel>
                <h3 className="bg-muted/40 px-4 py-2.5 text-sm font-semibold sm:px-5">Automatic limit resets</h3>
                <ToggleSetting
                  title="Redeem expiring resets"
                  detail={redeemExpiringDetail}
                  checked={s.redeemExpiring}
                  onChange={(redeemExpiring) => change({ redeemExpiring })}
                />
                <ToggleSetting
                  title="Redeem when a pool is limited"
                  detail={redeemExhaustedDetail}
                  checked={s.redeemWhenExhausted}
                  onChange={(redeemWhenExhausted) => change({ redeemWhenExhausted })}
                />
                <h3 className="border-t bg-muted/40 px-4 py-2.5 text-sm font-semibold sm:px-5">Reminders</h3>
                <ReminderRows notify={s.notify} />
              </Panel>
            </Section>
          </>
        )
      }}
    </Loaded>
  )
}

function AdvancedSection({ view }: { readonly view: SettingsView }) {
  const change = useAtomSet(changeSettings)
  const summaryId = useId()
  const set = (name: LiveKey, value: boolean | number) => Option.map(livePatch(name, value), change)
  return (
    <Collapsible>
      <Panel>
        <h2>
          <CollapsibleTrigger
            render={<Button variant="disclosure" size="disclosure" className="group" />}
            aria-label="Advanced proxy settings"
            aria-describedby={summaryId}
          >
            <span className="flex flex-col gap-1">
              <span className="font-heading text-base font-semibold">Advanced proxy settings</span>
              <span id={summaryId} className="text-sm font-normal text-muted-foreground">
                Session timeout, ChatGPT windows, polling, sign-ins and WebSockets.
              </span>
            </span>
            <ChevronDown aria-hidden className="group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent>
          <div className="border-t">
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
                    title={row.name === "pollMinutes" ? "polling interval" : "session timeout"}
                    value={row.shown}
                    onLess={row.less === undefined ? undefined : () => set(row.name, row.less ?? row.value)}
                    onMore={row.more === undefined ? undefined : () => set(row.name, row.more ?? row.value)}
                  />
                </SettingRow>
              ),
            )}
            <p className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
              To override session affinity for one request, set{" "}
              <code className="font-mono whitespace-nowrap">{affinityHeader}</code> to on or off.
            </p>
          </div>
        </CollapsibleContent>
      </Panel>
    </Collapsible>
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
    <div className="flex w-full max-w-6xl flex-col gap-4">
      {waiting === undefined && view !== undefined && (
        <p className="text-xs text-muted-foreground">
          Proxy switches and steppers autosave to <code className="font-mono">config.toml</code>. Strategy saves on
          Apply.
        </p>
      )}
      <div className="grid items-start gap-6 @4xl:settings-columns @4xl:gap-8">
        <div className="flex min-w-0 flex-col gap-5 sm:gap-7">
          {waiting === undefined ? (
            // Running, or still finding out: the settings show as soon as the proxy answers for them.
            <LiveSections />
          ) : (
            <Section title="Routing">
              {!readOnly && (
                <p className="text-sm text-muted-foreground">
                  To change proxy settings, run <code className="font-mono">slopmax config</code> on the machine running
                  slopmax.
                </p>
              )}
              {report !== undefined && (
                <Panel>
                  <StrategySummary
                    strategy={report.strategy}
                    summary={strategySummaries[report.strategy]}
                    reportedAt={unanswered || !report.live ? dateTime(report.generatedAt, zone) : undefined}
                  />
                </Panel>
              )}
              {readOnly && report === undefined && (
                <p className="text-sm text-muted-foreground">Waiting for the proxy to report its routing strategy.</p>
              )}
            </Section>
          )}
          {waiting === undefined && view !== undefined && <AdvancedSection view={view} />}
        </div>
        <aside className="flex min-w-0 flex-col gap-5 sm:gap-7" aria-label="Browser preferences and proxy details">
          <AppearanceSection />
          <ProxySection listen={view?.settings.listen} />
        </aside>
      </div>
    </div>
  )
}
