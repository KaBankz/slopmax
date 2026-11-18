# Design

The slopmax UI is built on [shadcn/ui](https://ui.shadcn.com): its design
system, its components, and its conventions, with as little of our own as we
can manage. It is the web dashboard, served by the daemon at `/slopmax/`;
`src/host.ts` holds what it needs from the browser.

The stack is React 19, Tailwind CSS 4 and shadcn/ui's `base-nova` style, whose
components sit on [Base UI](https://base-ui.com). Run `mise run check` from
`web/` before you call a UI change done.

## The layers

1. **The theme**, `src/index.css`: shadcn's own, as `shadcn init -b base -p nova`
   writes it. Tokens in `:root` and `.dark`, mapped to colors in
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
`input`, `ring`, `chart-1` … `chart-5`, and the `sidebar-*` set, each with its
`-foreground` where shadcn has one. The values are shadcn's neutral defaults
(oklch), and `--radius` (0.625rem) sets every radius step.

slopmax adds tokens shadcn has no names for: `success` and `warning`, the
good and warn states (`destructive` is the bad one), which take Tailwind's
green and amber, 700 in light and 500 in dark; and `spark-1` … `spark-4`, the
trend lines under the figures (API value, tokens, requests, the fourth),
orange, pink, blue and teal, deeper in light. A chart of the same measure
as a figure takes that figure's color (the Usage page's tokens, requests and
API value columns, and the "When you work" grid, which counts requests). A
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
columns not under the pointer step back; a curve is smooth and 2px over
its fill. A list row's bar is `ChartMeter`, the same dither on its side over
a dotted track, fading over the track's length so short bars stay solid.
State meters (a pool's use, with warning and failure tones) stay `Meter`.

Type, spacing, radius, shadows and motion are Tailwind's and shadcn's: `text-sm`
is body text, `text-xs` secondary text, `text-base` and up for headings;
spacing on Tailwind's 4px steps; enter and exit motion from `tw-animate-css`
(`animate-in fade-in slide-in-from-top-1`). The font is the system's sans, so
the page ships no font files.

To change the look, change the theme's values, never the components. A theme
from shadcn's theme pages pastes straight over `:root` and `.dark`; keep
`success` and `warning` and check they still read against its background.

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
| `progress` | `tone` (`default`, `warning`, `destructive`) colors the fill; `marker` draws a tick where an even spend would have reached                                                                                                                                                                                                  |
| `card`     | a `flush` size, no padding or gap, for a panel of rows edge to edge                                                                                                                                                                                                                                                         |
| `chart`    | series colors are set in the container's `style`, not an injected `<style>` (the CSP refuses one), so a series takes `color`, not `theme`; `ChartArea` (`texture`: `dither`, `fade`), `ChartLine` and `ChartBar` (`variant`: `dither`, `solid`) draw every series in the house look; `ChartMeter` is a list row's bar in it |
| `sonner`   | the theme comes from slopmax's Appearance setting, not next-themes                                                                                                                                                                                                                                                          |
| `sidebar`  | no cookie: whether it is open lives in slopmax's preferences                                                                                                                                                                                                                                                                |

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

| File            | What                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parts.tsx`     | `Panel` (Card, flush), `Section`, `Row`, `SettingRow` (Item), `Stat`/`Stats` (Card, a `Spark`; `lg` for headlines), `Empty`, `Skeleton`, `Failed` (Alert), `Loaded`, `Meter` and `SegmentedBar` (Progress), `Label`, `Dot`, `Logo`, `Kbd` |
| `charts.tsx`    | `Columns`, `Lines`, `Hours`, `TrendChart`, `Spark`, `Share` (Chart over Recharts); `Heatmap` (a contribution graph) and `SplitBar`, which Recharts has no shape for; `Legend`, `Swatch`                                                   |
| `forecast.tsx`  | `PoolForecast` (Card, Segmented, TrendChart, figures in the CardFooter), `ResetLanes` (Card, Tooltip marks on a lane per account), `HealthStrip` (a Tooltip over an account's half hours)                                                 |
| `sidebar.tsx`   | the window's Sidebar: SidebarProvider sized from the preferences, a draggable edge, the pages, the proxy's state at its foot                                                                                                              |
| `tip.tsx`       | `Tip`, a Tooltip on one control in a line                                                                                                                                                                                                 |
| `health.tsx`    | the overview's `HealthCard` (Card, a HealthStrip per account) and `RecentFailures` (Card, CardAction to the Requests page)                                                                                                                |
| `pick.tsx`      | `Pick`, a small Select of a few choices or "any", for filters                                                                                                                                                                             |
| `segmented.tsx` | `Segmented`, a ToggleGroup that always keeps one choice                                                                                                                                                                                   |
| `choices.tsx`   | `Choices`, a RadioGroup of choice cards (FieldLabel around a Field)                                                                                                                                                                       |
| `stepper.tsx`   | `Stepper`, less and more around a value (ButtonGroup)                                                                                                                                                                                     |
| `ask.tsx`       | the app's one confirm-or-prompt Dialog, opened with `ask(…)`                                                                                                                                                                              |
| `toasts.tsx`    | hands the toasts atom's entries to Sonner                                                                                                                                                                                                 |
| `sign-in.tsx`   | the sign-in Card above every page while a sign-in is under way                                                                                                                                                                            |

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
