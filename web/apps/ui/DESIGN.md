# Design

The slopmax UI is built on [shadcn/ui](https://ui.shadcn.com): its design
system, its components, and its conventions, with shared Slopmax variants for quota, chart texture, spacing, and focus. It is the web dashboard, served by the daemon at `/slopmax/`;
`src/host.ts` holds what it needs from the browser.

The stack is React 19, Tailwind CSS 4 and shadcn/ui's `base-nova` style, whose
components sit on [Base UI](https://base-ui.com). Run `mise run check` from
`web/` before you call a UI change done.

## Navigation

Quota is the landing page for reset deadlines, remaining subscription allowance,
and account actions. Accounts groups providers by billing type and owns the
add-account flow. Directory rows show the tightest shared limit and the last
proxy request for each account. Activity groups Usage, Requests, and Performance. Proxy groups
Settings, Coding agents, Client access, and Diagnostics. The proxy status opens
Diagnostics directly.

The same four navigation links appear in the masthead on desktop and in the
bottom bar on phones. Provider hashes and account links retain their existing
addresses. Route changes focus the page title or the account named in the
link. The Accounts directory is `#/accounts` and adding credentials is
`#/accounts/add`.

## The layers

1. **The theme**, `src/index.css`: built on shadcn's `base-nova` tokens. Tokens in `:root` and `.dark`, mapped to colors in
   `@theme inline`, on Tailwind's default type, spacing and radius scales, with
   `tw-animate-css` and `shadcn/tailwind.css` imported.
2. **shadcn's components**, `src/components/ui/`: added with the CLI and kept
   as close to upstream as possible. A change here is a customization of
   shadcn's component and says so in a comment at the top of the file.
3. **Our compositions**, `src/components/`: small components built only from
   layer 2 (and plain layout elements), for patterns the pages repeat.
4. **Pages**, `src/pages/`: built from layers 2 and 3. A page reaches for a
   shadcn component first, a composition second, and a plain `div` only for
   layout.

## Theme

shadcn's tokens, by shadcn's names: `background`, `foreground`, `card`,
`popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`,
`input`, `ring`, and `chart-1` … `chart-5`, each with its
`-foreground` where shadcn has one. Warm neutral surfaces frame violet actions. The quota lead reserves amber for remaining allowance and uses dither on the portion already spent.
`--radius` (0.625rem) sets every radius step.

slopmax adds tokens shadcn has no names for: `success` and `warning`, the
good and warn states (`destructive` is the bad one), which take Tailwind's
green and amber, 700 in light and 500 in dark; and `spark-1` … `spark-4`, the
trend lines under the figures (value at API prices, tokens, requests, the fourth),
orange, pink, blue and teal, deeper in light. A chart of the same measure
as a figure takes that figure's color (the Usage page's tokens, requests and
value at API prices columns, and the weekday activity grid, which counts requests). A
row that is one provider's (a model, an agent, an account, a speed) takes
that provider's color from the Tokens chart, grey when no one provider owns
it; the neutral `chart-*` colors stay for the rest.

Every chart draws its series with `ChartArea`, `ChartLine` and `ChartBar`
from `components/ui/chart.tsx`, never Recharts' own `Area`, `Line` and `Bar`
(oxlint refuses those imports outside `components/ui/`). So a change to how
charts look is made there once. Both bars and the fills under curves are an
ordered (Bayer) dither in the series' color, after Dither Kit's: 2px cells
lit where the density beats the matrix, solid at the foot and thinning to a
scatter at the top, the unlit cells a faint tint. A bar fades from its
column's top under a soft rounded cap (a stack fades as one column), and the
columns not under the pointer step back. Bars narrower than two dither tiles
use a solid fill, with a small cap for a nonzero top segment below one pixel.
A curve is smooth and 2px over
its fill. A list row's bar is `ChartMeter`, the same dither on its side over
a dotted track, fading over the track's length so short bars stay solid. Dither marks historical
measurements and usage breakdowns. Account row gauges and categorical status grids use solid fills. On Overview, the
featured account's gauge stipples the used segment so it reads against the remaining track.

Type, spacing, radius, shadows and motion are Tailwind's and shadcn's: `text-sm`
is body text, `text-xs` secondary text, `text-base` and up for headings;
spacing on Tailwind's 4px steps; enter and exit motion from `tw-animate-css`
(`animate-in fade-in slide-in-from-top-1`). The system sans handles controls and body text. Bricolage Grotesque gives headings and
the lead quota figure a distinct scale. Its Latin subset and OFL ship with the app.

Change shared colors in the theme and component behavior in the relevant shadcn primitive.
Check both themes for contrast and focus when changing a token.

### Quota

Overview leads with the next eligible shared window and its reset queue. Keep
weekly and monthly windows together in the long-window selection and show 5-hour
windows separately. The pace to finish is the remaining percentage points
divided by the hours until the reported reset. The gauge marks even pace,
and matched reset reminders supply estimates of the unused plan fee. Usage shows historical subscription
value from completed resets alongside its price basis. Provider pages show
pool forecasts, model caps, account controls, and short-window constraints.

### State

State reaches the page as a `Tone` from `@slopmax/client` (`good`, `muted`,
`accent`, `warn`, `bad`). Show it with `Dot` and `Label` from
`components/parts.tsx`, meters with `Meter` (a shadcn `Progress` with a
`tone`), and never with colors picked in place.

## shadcn's components

These are in `src/components/ui/`. Use them as their docs show:

Alert, AlertDialog, Badge, Button, ButtonGroup, Card, Chart, Collapsible,
Dialog, DropdownMenu, Empty, Field, Input, InputGroup, Item, Kbd, Label,
Progress, RadioGroup, Separator, Sheet, Sidebar, Skeleton, Sonner (Toaster),
Spinner, Switch, Table, Textarea, Toggle, ToggleGroup, Tooltip.

Our customizations, each noted at the top of its file:

| Component  | Change                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alert`    | a `warning` variant, the destructive variant's shape in the warning color                                                                                                                                                                                                                                                   |
| `progress` | `tone` colors the fill and supports a patterned quota gauge. `marker` shows the even-spend target                                                                                                                                                                                                                           |
| `card`     | a `flush` size for rows, a `quota` variant for the lead window, and a compact content density for narrow tables                                                                                                                                                                                                             |
| `chart`    | series colors are set in the container's `style`, not an injected `<style>` (the CSP refuses one), so a series takes `color`, not `theme`; `ChartArea` (`texture`: `dither`, `fade`), `ChartLine` and `ChartBar` (`variant`: `dither`, `solid`) draw every series in the house look; `ChartMeter` is a list row's bar in it |
| `sonner`   | the theme comes from slopmax's Appearance setting, not next-themes                                                                                                                                                                                                                                                          |

### Adding one

From `web/apps/ui`:

```sh
bunx shadcn add <component>
```

`components.json` sends it to `src/components/ui/`, with `@/` meaning `src/`.
It arrives styled for our theme, since the theme is shadcn's. Don't pass
`--overwrite` for a component listed above, or its customization is lost; to
take an upstream update of one, diff it first (`bunx shadcn add <name> --diff`)
and carry the change over.

## Our compositions

In `src/components/`, each built from shadcn's components:

| File             | What                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parts.tsx`      | `Panel` (Card, flush), `Section`, `Row`, `SettingRow` (Item), `Stats` (one Card with `Spark` trends), `Empty`, `Skeleton`, `Failed` (Alert), `Loaded`, `Meter` and `SegmentedBar` (Progress), `Label`, `Dot`, `Logo`, `Kbd` |
| `charts.tsx`     | `Columns`, `Lines`, `Hours`, `TrendChart`, `Spark`, `Share` (Chart over Recharts); `Heatmap` (a contribution graph) and `SplitBar`, which Recharts has no shape for; `Legend`, `Swatch`                                     |
| `forecast.tsx`   | `PoolForecast` (Card, Segmented, TrendChart, figures in the CardFooter), `ResetLanes` (Card, account timeline and expandable reset times), `HealthStrip` (a status strip with a visible summary)                            |
| `navigation.tsx` | Masthead, contextual page links, and proxy diagnostics. Uses shadcn ButtonLink variants.                                                                                                                                    |
| `tip.tsx`        | `Tip`, a Tooltip on one control in a line                                                                                                                                                                                   |
| `health.tsx`     | the overview's `HealthCard` (Card, a HealthStrip per account) and `RecentFailures` (Card, CardAction to the Requests page)                                                                                                  |
| `pick.tsx`       | `Pick`, a small Select of a few choices or "any", for filters                                                                                                                                                               |
| `segmented.tsx`  | `Segmented`, a ToggleGroup that always keeps one choice                                                                                                                                                                     |
| `choices.tsx`    | `Choices`, a RadioGroup of choice cards (FieldLabel around a Field)                                                                                                                                                         |
| `stepper.tsx`    | `Stepper`, less and more around a value (ButtonGroup)                                                                                                                                                                       |
| `ask.tsx`        | the app's one confirm-or-prompt Dialog, opened with `ask(…)`                                                                                                                                                                |
| `toasts.tsx`     | hands the toasts atom's entries to Sonner                                                                                                                                                                                   |
| `sign-in.tsx`    | the sign-in Card above every page while a sign-in is under way                                                                                                                                                              |

A new pattern that two pages share becomes a composition here, built the same
way. Every file opens with a comment saying what it is.

## Rules

`oxlint` with shadcn's own linter (`@shadcn/lint`) and
`eslint-plugin-better-tailwindcss` checks these in `src/**/*.tsx`:

| Rule                                        | What it means here                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shadcn/no-raw-colors`                      | Theme tokens only: no `bg-pink-500`, hex, `white` or `black`                                                                                           |
| `shadcn/no-restyle`                         | Outside `components/ui/`, pass a shadcn component layout classes only (`CardTitle` may also take type). Use its variants and sizes, or a plain wrapper |
| `shadcn/no-arbitrary-values`                | No `p-[13px]`; use the scale                                                                                                                           |
| `shadcn/require-static-classes`             | Static class strings on components                                                                                                                     |
| `shadcn/no-inline-styles`                   | No `style`, except setting CSS custom properties read by static classes (`style={{ "--h": … }}` with `h-(--h)`)                                        |
| `shadcn/no-unknown-classes`                 | Only classes this Tailwind can generate                                                                                                                |
| `better-tailwindcss/no-conflicting-classes` | No `p-2 p-4`                                                                                                                                           |

In `components/ui/` these are off, along with our stricter TypeScript rules,
so shadcn's code stays as upstream wrote it. Don't silence a rule elsewhere
with `oxlint-disable`; if a page needs what a component can't do, add a
variant to the component (and note it above).

**The content security policy.** The daemon allows only the page's own
scripts, styles, fonts and API, plus one inline stylesheet by its hash:
Sonner's. A library that injects `<style>` tags at run time works under
`bun dev.ts` and breaks in the real dashboard, so check before adding one.
`test/csp.test.ts` fails when a Sonner upgrade changes its stylesheet; update
the hash in `crates/slopmax-daemon/src/proxy/ui.rs` when it does.

**Size** is measured and recorded in `package.json`. Note the new figure there
when a dependency moves it.

## Words

The UI's sentences come from pure functions in `src/view/` (`words.ts` for
most), so tests read them as people will. Say what happened and what to do,
in plain words: "slopmax is not answering. Is it running? Start it with
slopmax proxy start." Never show a request's method and address. Times give both
the countdown and the clock time: "Resets in 51m46s · 02:18".
