# Styling the desktop app's renderer

Decision record for `apps/desktop` (Electron 45, electron-vite 6, Vite 8, React 19).
Researched and prototyped on 2026-10-30.

## Question

Does Tailwind CSS v4 with shadcn/ui and shadcn's lint plugin give us what
StyleX's type safety gives us? If so, should we use Tailwind?

The two candidates:

- **(A) StyleX** (`@stylexjs/stylex` 0.19.1). You write styles as typed objects,
  and a compiler turns them into atomic CSS at build time.
- **(B) Tailwind CSS v4.3.3 with shadcn/ui** (`shadcn` 4.23.0, Base UI
  primitives), checked by `@shadcn/lint` 0.2.3.

The UI library is React 19 either way. Base UI, shadcn/ui, and the two lint
plugins all target React first. The app is a small dashboard that reads one
subscribed snapshot, so another UI library would gain us nothing.

**Short answer:** for this app, mostly yes. The linter catches more styling
mistakes than StyleX's types do. StyleX still has three things the linter
cannot match: style limits written into a component's own types, tokens you
can refactor as code, and conflict-free overrides with no runtime cost.
These are small gains for one small app, and they do not outweigh shadcn's
component set or how well AI agents handle Tailwind. **Use Tailwind with
shadcn/ui, and run `@shadcn/lint` under oxlint.** See
[Recommendation](#recommendation).

## What the shadcn lint plugin is

I checked these facts against the npm tarball, the
[shadcn-ui/lint](https://github.com/shadcn-ui/lint) repository and its docs,
and by running the plugin. Nothing here comes only from blog posts.

- **Package:** `@shadcn/lint`, MIT license, by shadcn. It lives in its own repo,
  `github.com/shadcn-ui/lint` (created 2026-09-02, about 3.3k stars, 19 open
  issues). It is not part of the `shadcn` CLI package.
- **Versions:** 0.1.0 came out on 2026-09-14. The latest is 0.2.3, from
  2026-10-19. It had about 2.9M weekly npm downloads at the time of writing.
- **What it is:** "A programmable agent-first linter for Tailwind design
  systems." It needs Tailwind v4. It does **not** need shadcn/ui: without a
  `components.json` it finds your theme CSS and your component directory
  itself, and `settings.shadcn.ui` / `componentImports` can point it elsewhere.
- **Hosts:** it is one ESLint-API plugin. It runs on **ESLint ≥ 9.30** and on
  **Oxlint ≥ 1.80 through `jsPlugins`**. Both peer dependencies are optional,
  and Node ≥ 20.19 is required. The README says Bun 1.3+ works too. Oxlint
  reads only the `<script>` blocks of Vue and Svelte files, which does not
  matter for React.
- **Rules (six):**

  | Rule                     | What it checks                                                                                                                                                                                                                                                                                                                   |
  | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `no-restyle`             | `className` passed to a design-system component. Policy is set per category (`layout`, `spacing`, `color`, `typography`…), per class group, or per pattern. Per-component `contracts` are regexes on the resolved component name. It follows imports, re-exports, wrappers that forward `className`, and Base UI `render` props. |
  | `no-raw-colors`          | Tailwind palette colors (`bg-pink-500`), color tokens your `@theme` does not declare (`text-sucess`), and literal colors in SVG `fill`/`stroke`/… attributes.                                                                                                                                                                    |
  | `no-arbitrary-values`    | `p-[13px]`, `bg-[#333]`, `[padding:13px]`. It suggests the matching scale step or the nearest theme color, compared in OKLab.                                                                                                                                                                                                    |
  | `no-inline-styles`       | `style={{…}}` properties, colors hardcoded in custom properties, and `<style>` elements.                                                                                                                                                                                                                                         |
  | `no-unknown-classes`     | Classes that your installed Tailwind (with your theme and plugins) cannot generate. It loads Tailwind in a worker thread to check them.                                                                                                                                                                                          |
  | `require-static-classes` | Class values it cannot read statically, such as `` `bg-${c}-500` `` on components.                                                                                                                                                                                                                                               |

- **How it works:** it is static analysis only. It reads `cva`/`tv` variant
  definitions and string-union prop types from the component's file, so its
  messages can list the real variants and sizes. It reads `--color-*`,
  radius, and text tokens from `@theme`. It also reads class helpers (`cn`,
  `cx`, `clsx`, `cva`, `tv`, `twMerge`…) and follows variables one hop. Every
  rule accepts a custom `message` with placeholders (`{{variants}}`,
  `{{sizes}}`, `{{file}}`), and a global `settings.shadcn.note` is added to
  every finding.
- **What it cannot catch:** misspelled variant _values_ such as
  `variant="danger"`; that is TypeScript's job, through cva's `VariantProps`.
  It also misses conflicting utilities (`p-2 p-4`, `flex hidden`) and values
  that sit on Tailwind v4's continuous spacing scale but off our design
  (`m-13`, `w-77`, `p-3.25`). Semantic misuse of a declared token
  (`bg-destructive` on neutral content) passes. `text-white` and `bg-black`
  pass unless you add a `deny` entry. Anything behind
  `// oxlint-disable-next-line` passes. All of these were confirmed in the
  prototype.
- **Evals (vendor-reported, not re-run here):** in over 150 agent task runs,
  almost every task reached zero violations after one round of lint feedback,
  and the README reports 10–48% lower fix cost than with written rules alone.

## Comparison table

"Caught" means reported by `tsc`/`bun check` or the linter before the app
runs. The **Prototype** column says whether this evaluation reproduced the
claim.

| Concern                                   | StyleX 0.19 (+ `@stylexjs/eslint-plugin`)                                                                                                                                                           | Tailwind 4 + shadcn/ui + `@shadcn/lint`                                                                                                                                                                 | Prototype                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Unknown CSS property / class              | **Lint only** (`valid-styles`). `tsc` accepts `colour: "red"`, and the compiler emits `.x{colour:red}` without a word.                                                                              | **Lint** (`no-unknown-classes`) asks the real Tailwind and suggests a fix ("Did you mean `flex-col`?").                                                                                                 | yes                        |
| Invalid value for a property              | **Lint only** (`display: "flexx"` lists the valid keywords). `tsc` and the compiler accept it.                                                                                                      | Lint, because an invalid class is an unknown class.                                                                                                                                                     | yes                        |
| Misspelled token                          | **`tsc`**: `colors.sucess` → TS2551 "Did you mean 'success'?". The compiler alone would emit `var(--hash)` pointing at nothing.                                                                     | **Lint** (`no-raw-colors`): "`text-sucess` is not a declared theme color. Did you mean `text-success`?"                                                                                                 | yes                        |
| Raw / off-system colors                   | Not caught by default. Lint can do it with `valid-styles` `propLimits` per property; tokens pass, literals fail, but the message is generic and drops our `reason`.                                 | **Lint**, with the nearest token and the theme file named. It also covers SVG `fill`/`stroke`.                                                                                                          | yes                        |
| Off-scale spacing / radius                | Lint with `propLimits` (for example `padding*: [0]` forces `space.*` tokens).                                                                                                                       | Lint for `p-[13px]` (suggests `p-3.25`). **Not** for `m-13` or `p-3.25`, which are valid steps on v4's scale.                                                                                           | yes                        |
| Inline `style`, `<style>`                 | Only `no-conflicting-props`, when `style` sits beside `stylex.props()` on one element. A plain `style={{color:"#f00"}}` passes.                                                                     | **Lint** (`no-inline-styles`), property by property.                                                                                                                                                    | yes                        |
| Variant names                             | **`tsc`** (`keyof typeof variants`)                                                                                                                                                                 | **`tsc`** (cva `VariantProps`); the linter does not check this                                                                                                                                          | yes, both                  |
| What a caller may override on a component | **`tsc`**: `xstyle?: StyleXStyles<{width?…; marginTop?…}>` rejects padding and color at every call site, in any editor, with no config.                                                             | **Lint**: `no-restyle` with `allow: ["layout"]` plus contracts. It is policy in config, matched by component name, and it suggests the fix from the component's real variants.                          | yes, both                  |
| Conflicting styles                        | Impossible by design: within one element the last style wins, settled at compile time. A duplicate key is `tsc` TS1117.                                                                             | Not caught (`p-2 p-4` passes). Conflicts on a component are settled at **runtime** by `cn` (tailwind-merge semantics).                                                                                  | yes                        |
| Dynamic styles                            | Typed functions are allowed. `StaticStyles` can forbid them on a prop.                                                                                                                              | `require-static-classes` forbids unreadable class strings. Values go through CSS variables.                                                                                                             | yes                        |
| Refactoring tokens                        | Tokens are TS exports, so rename, find-references, and unused-import checks work.                                                                                                                   | Tokens are CSS custom properties referenced by string; rename means grep.                                                                                                                               | —                          |
| Theming, light/dark                       | `defineVars` (in `*.stylex.ts`) plus `createTheme`, applied as a class anywhere in the tree. Media-query values in `defineVars` are an option. Typed: a theme must supply every var.                | `:root` / `.dark` variables mapped through `@theme inline`, with `@custom-variant dark`. shadcn ships the full token set (background, card, muted, destructive, chart-_, sidebar-_…). Nothing types it. | yes, both                  |
| Component ecosystem                       | None to speak of. The StyleX ecosystem page lists no component library. You hand-build on Base UI or React Aria (headless) and write every style yourself.                                          | shadcn/ui (Base UI default since 2026-07; Radix and React Aria also offered) comes with dialogs, menus, tooltips, toasts, tables, charts and more, copied into the repo where we own them.              | yes (Base UI used in both) |
| Styles across component boundaries        | `xstyle` props are typed and merge deterministically.                                                                                                                                               | `className` plus `cn`. Policy is enforced by `no-restyle`.                                                                                                                                              | yes                        |
| AI-agent fit                              | Correct by construction where types reach. TS errors are precise but give no design guidance. There is far less public StyleX code for models to draw on. `stylexjs.com/docs/llm-resources` exists. | Models write Tailwind fluently. The linter is built for agents: each error names the allowed variants and sizes, the nearest token, and the file to edit.                                               | yes                        |
| Vite 8 / electron-vite 6                  | `@stylexjs/unplugin` → `stylex.vite()`, placed before `react()`. Needs a CSS entry to append to. Built fine under electron-vite 6.                                                                  | `@tailwindcss/vite`. Built fine under electron-vite 6.                                                                                                                                                  | yes                        |
| Bun bundler path (if we ever drop Vite)   | `stylex.esbuild()` in `Bun.build`, plus `@stylexjs/unplugin/bun` for `bun serve` (documented, not tested here).                                                                                     | `bun-plugin-tailwind` 0.1.2 (not tested here).                                                                                                                                                          | —                          |
| CSS output (this prototype, minified)     | **5.8 kB** (1.8 kB gzip)                                                                                                                                                                            | **31.2 kB** (6.3 kB gzip), including Preflight, the full token set, `shadcn/tailwind.css` and `tw-animate-css`                                                                                          | yes                        |
| JS runtime cost                           | `stylex.props` merge, about 1.5 kB min. +2.1 kB over baseline.                                                                                                                                      | `cn` 26.4 kB min (10.8 kB gzip) + `cva` 1.3 kB, plus class strings. +33.3 kB over baseline. `cn` also offers a `cn/vite` build step to shrink this (not measured).                                      | yes                        |
| Lint / check speed (this prototype)       | oxlint + StyleX plugin: 0.3 s                                                                                                                                                                       | oxlint + `@shadcn/lint`: 0.9–1.4 s (loads Tailwind in a worker)                                                                                                                                         | yes                        |
| Maturity                                  | Pre-1.0 (0.19.1 from 2026-09-15). Meta-backed and used across Meta's apps. About 2.4M weekly downloads, 10k stars.                                                                                  | Tailwind about 168M weekly downloads. shadcn about 16.7M, 127k stars, very active. `@shadcn/lint` is **6 weeks old (0.x)**.                                                                             | —                          |
| DX                                        | Verbose objects, but autocomplete and typed tokens. One theme mechanism.                                                                                                                            | Short; no names to invent. Long class strings in components. Errors are prose with suggestions.                                                                                                         | —                          |

## Prototype results with the exact errors caught

The prototypes live under `/tmp/styling-proto` (scratch; nothing in the repo):

- `a-stylex/`: Vite 8 + React 19.3.1 + `@stylexjs/unplugin` 0.19.1 + Base UI 1.9.
- `b-tailwind/`: Vite 8 + React 19.3.1 + Tailwind 4.3.3, set up with
  `shadcn init -t vite -b base -p nova` and `shadcn add badge card progress`.
- `c-baseline/`: the same React and Base UI parts with no styling, used as the
  size baseline.

Both apps build the same screen. It has an account card with a header, a
status badge, two usage meters (5-hour and weekly), and a footer with three
buttons. The status badge has variants `active | cooling | exhausted |
signedOut`. The button has variants and sizes, and its outside callers may
set only margin and width. A toggle switches light and dark. Each app adds
its own `success` and `warning` tokens.

Both also built cleanly with `electron-vite build` (electron-vite 6.0.0,
electron 45.1.0), with the renderer configured as above. Toolchain: Bun 1.4.4
(`bun install`, `bun run`, `bun check`), TypeScript 7.0.2, oxlint 1.90.0.

### Tailwind: `oxlint` + `@shadcn/lint` 0.2.3 on deliberately wrong code

Config: all six rules at `error`, with `no-restyle` set to `allow: ["layout"]`
plus a contract that lets `CardContent`/`CardFooter` take spacing.
`no-arbitrary-values` allows `layout`. `no-restyle`, `no-arbitrary-values` and
`require-static-classes` are off in `src/components/ui/**`, as the docs
advise. shadcn's own generated components use arbitrary values such as
`rounded-[min(var(--radius-md),10px)]`, `text-[0.8rem]` and
`hover:bg-[color-mix(…)]`.

Our own _correct_ first draft was flagged too. `gap-3` on `<CardContent>`
and `gap-2` on `<CardFooter>` gave "`<CardContent>` owns its spacing". It
needed the contract above, so expect to tune the config at first.

Output, verbatim (19 findings; identical under `bun --bun oxlint`):

```
wrong.tsx:12:22: error shadcn(no-raw-colors): "bg-pink-500" uses the raw Tailwind palette and no declared theme color is close to it. Use one of: accent, background, border, card, chart-1, chart-2, chart-3, chart-4, chart-5, destructive, foreground, input (+21 more), or declare --color-<name> in src/index.css for a new color.
wrong.tsx:12:22: error shadcn(no-raw-colors): "text-zinc-100" uses the raw Tailwind palette. Nearest theme tokens: text-muted, text-primary-foreground. Use one of those, or declare --color-<name> in src/index.css for a new color.
wrong.tsx:14:22: error shadcn(no-raw-colors): "text-sucess" is not a declared theme color. Did you mean "text-success"? Declared colors: accent, background, border, …
wrong.tsx:16:22: error shadcn(no-arbitrary-values): "bg-[#ec4899]" hardcodes a color and no declared theme color is close to it. Use one of: … or declare --color-<name> in src/index.css.
wrong.tsx:16:22: error shadcn(no-arbitrary-values): "p-[13px]" hardcodes an off-token value. Use "p-3.25" instead (same value, on the scale).
wrong.tsx:16:22: error shadcn(no-arbitrary-values): "rounded-[10px]" hardcodes an off-token value. Use "rounded-lg" instead (same value, on the scale).
wrong.tsx:18:22: error shadcn(no-unknown-classes): "flex-cols" is not a class this project's Tailwind knows, so no CSS is generated for it. Did you mean "flex-col"?
wrong.tsx:18:22: error shadcn(no-unknown-classes): "rounded-huge" is not a class this project's Tailwind knows, so no CSS is generated for it. Fix the spelling, or declare it with @utility in src/index.css.
wrong.tsx:18:22: error shadcn(no-unknown-classes): "hovr:flex" is not a class this project's Tailwind knows, so no CSS is generated for it. Did you mean "hover:flex"?
wrong.tsx:20:28: error shadcn(no-inline-styles): Inline style sets color. Style through classes; use CSS custom properties for dynamic values.
wrong.tsx:20:48: error shadcn(no-inline-styles): Inline style sets padding. Style through classes; use CSS custom properties for dynamic values.
wrong.tsx:22:25: error shadcn(no-restyle): "bg-pink-500" is not allowed on <Button>: <Button> owns its color. Use a variant: default, outline, secondary, ghost, destructive, link. Add a new variant in src/components/ui/button.tsx only if the design explicitly calls for a treatment none of these provides.
wrong.tsx:22:25: error shadcn(no-restyle): "p-4" is not allowed on <Button>: <Button> owns its spacing. Use a size (default, xs, sm, lg, icon, icon-xs, icon-sm, icon-lg), or margin here, gap on a plain wrapper around it, or CardFooter and CardContent for space around it. Add a size in src/components/ui/button.tsx only if the design explicitly calls for one.
wrong.tsx:22:25: error shadcn(no-restyle): "rounded-full" is not allowed on <Button>: <Button> owns its shape. Use a variant: …
wrong.tsx:22:25: error shadcn(no-raw-colors): "bg-pink-500" uses the raw Tailwind palette …
wrong.tsx:23:28: error shadcn(no-restyle): "font-bold" is not allowed on <CardTitle>: <CardTitle> owns its typography. Add a variant in src/components/ui/card.tsx only if the design explicitly calls for this treatment.
wrong.tsx:29:26: error shadcn(require-static-classes): Dynamically built className on <Button> cannot be checked. Use static class strings.
wrong.tsx:33:12: error shadcn(no-raw-colors): fill="#ec4899" hardcodes a color. Use currentColor with a text color class, or var(--color-<token>).
wrong.tsx:37:7: error shadcn(no-inline-styles): A <style> element injects CSS outside the design system. Use classes, or declare the rule in your theme CSS.
```

On the same file, `tsc` (and `bun check`, which printed the same errors) caught
the misspelled variant names that the linter does not look at:

```
wrong.tsx(25,15): error TS2322: Type '"danger"' is not assignable to type '"default" | "destructive" | "ghost" | "link" | "outline" | "secondary" | null | undefined'.
wrong.tsx(26,14): error TS2322: Type '"sucess"' is not assignable to type '"default" | "destructive" | "ghost" | "link" | "outline" | "secondary" | null | undefined'.
wrong.tsx(27,20): error TS2322: Type '"paused"' is not assignable to type '"active" | "cooling" | "exhausted" | "signedOut" | null | undefined'.
```

**Not caught by anything** in a second probe file:
`className="p-2 p-4 flex hidden"` (conflicts), `m-13 w-77 p-3.25` (valid
steps on the scale), `text-white bg-black` (allowed by default), and
`bg-destructive` on neutral content (semantic misuse). Lines under
`// oxlint-disable-next-line` passed too. `bg-primary` on `<Button>`, a
system color used to restyle a component, _was_ caught by `no-restyle`.

### StyleX: `tsc` + `oxlint` + `@stylexjs/eslint-plugin` 0.19.1 on deliberately wrong code

Rules: `valid-styles` (with `propLimits` restricting `color`,
`backgroundColor` and `borderColor` to `inherit | currentColor |
transparent`, so only tokens pass), `valid-shorthands`, `no-unused`,
`no-conflicting-props`, `no-legacy-contextual-styles`,
`no-nonstandard-styles`, and `enforce-extension`. The plugin ran unchanged
through oxlint's `jsPlugins`, under the namespace `@stylexjs/...`.

`tsc --noEmit` (and `bun check`, the same errors):

```
wrong.tsx(13,30): error TS2551: Property 'sucess' does not exist on type 'VarGroup<Readonly<{ background: string; … success: string; … }>, symbol>'. Did you mean 'success'?
wrong.tsx(25,23): error TS1117: An object literal cannot have multiple properties with the same name.
wrong.tsx(39,15): error TS2322: Type 'Readonly<{ readonly padding: StyleXClassNameFor<"padding", string>; readonly backgroundColor: StyleXClassNameFor<"backgroundColor", string>; }>' is not assignable to type 'ButtonLayout'.
    Types of property 'backgroundColor' are incompatible.
      Type 'StyleXClassNameFor<"backgroundColor", string>' is not assignable to type 'undefined'.
wrong.tsx(41,15): error TS2322: Type '{ className: string; children: string; }' is not assignable to type '… Omit<…, "className" | "style"> & { … }'.
  Property 'className' does not exist on type …
wrong.tsx(43,15): error TS2322: Type '"danger"' is not assignable to type '"default" | "destructive" | "ghost" | "outline" | undefined'.
wrong.tsx(44,20): error TS2322: Type '"paused"' is not assignable to type '"active" | "cooling" | "exhausted" | "signedOut"'.
```

`oxlint`:

```
wrong.tsx:25:11: warning eslint(no-dupe-keys): Duplicate key 'padding'
wrong.tsx:19:16: error @stylexjs(valid-shorthands): Property shorthands using multiple values like "margin: 4px 8px" are not supported in StyleX. Separate into individual properties.
wrong.tsx:11:30: error @stylexjs(valid-styles): backgroundColor value must be one of: inherit currentColor transparent null initial inherit unset revert
wrong.tsx:11:48: error @stylexjs(valid-styles): color value must be one of: inherit currentColor transparent null initial inherit unset revert
wrong.tsx:17:14: error @stylexjs(valid-styles): This is not a key that is allowed by stylex
wrong.tsx:17:38: error @stylexjs(valid-styles): display value must be one of: none inline block flow-root list-item … flex inline-flex grid inline-grid … contents null initial inherit unset revert
wrong.tsx:37:45: error @stylexjs(no-conflicting-props): The `className` prop should not be used when spreading `stylex.props()` to avoid conflicts.
wrong.tsx:27:3: error @stylexjs(no-unused): Unused style detected: styles.unused
```

When `propLimits` also covered `padding*` and `borderRadius` (literal `0`
only), `padding: 13` and `borderRadius: 10` were reported ("padding value
must be one of: 0 …") and `space.*` / `radius.*` tokens passed. The rule
then flagged our own `paddingInline: 10` in `button.tsx` as well. The
`reason` text we configured never appeared in any message.

**Not caught by anything:** `style={{ color: "#ff0000", padding: 12 }}` on a
plain `div`, `fill="#ec4899"` on an SVG, the raw hex values _before_
`propLimits` was configured, and a dynamic style function.

**The StyleX compiler itself validates almost nothing.** I fed it
single-error modules through `@stylexjs/babel-plugin`. It compiled a raw hex
color, `colour: "red"` (emitting `.x1yhdcbj{colour:red}`), `display: "flexx"`
(emitting `display:flexx`), `margin: "4px 8px"`, the misspelled token
`colors.sucess` (emitting `color:var(--xphhetq)`, a variable nobody
defines), `stylex.create` inside a function (it hoisted the call), a dynamic
function, and `padding: 13`. It rejected only a runtime value ("Referenced
constant is not defined.") and `defineVars` outside a `.stylex.ts` file. The
real checking comes from `tsc` and the ESLint plugin, and `tsc` checks only
tokens and props, not CSS. "Compile-time type-safe styles" is mostly a
TypeScript claim and a lint claim.

### Sizes (Vite 8 production build, `build.target`/`cssTarget` = `chrome140`)

| Build                                                 | CSS raw / gzip / brotli | JS raw / gzip    | JS over baseline       |
| ----------------------------------------------------- | ----------------------- | ---------------- | ---------------------- |
| c-baseline (React 19.3 + the Base UI parts, unstyled) | —                       | 230,834 / 71,793 | —                      |
| a-stylex                                              | 5,794 / 1,785 / 1,525   | 232,907 / 72,896 | +2,073 / +1,103 gzip   |
| b-tailwind (shadcn)                                   | 31,215 / 6,278 / 5,536  | 264,142 / 84,479 | +33,308 / +12,686 gzip |

Runtimes alone (`bun build --minify`): `cn` 26,412 B (10,778 gzip), `cva`
1,272 B (600 gzip), StyleX `props` runtime 1,537 B (846 gzip). The Tailwind
CSS includes Preflight and shadcn's full token set; the StyleX build had a
three-line reset. StyleX's CSS stays small as the app grows because it is
atomic. Tailwind's grows with the number of distinct utilities, which is
also atomic, but the starting point is larger.

In an Electron renderer loaded from disk, about 30 kB of extra JS and 25 kB
of extra CSS cost low single-digit milliseconds to parse. This is not a
deciding factor.

### Other findings from the prototype

- **ESLint does not work with TypeScript 7.** `@typescript-eslint/parser`
  8.72.1 aborts with "typescript-eslint does not support TS 7.0". Both style
  plugins work through **oxlint `jsPlugins`**, which we use anyway. Oxlint
  marks JS plugins as **alpha**.
- TypeScript 7 rejects `baseUrl` (TS5102), so the `@/*` alias must use
  `paths` alone.
- StyleX's documented `StyleXStyles<{ marginTop?: unknown }>` fails with
  0.19.1's types (TS2344 "Type 'unknown' is not assignable to type
  'NotUndefined'"). Use concrete value types such as `string | number`.
- `shadcn init` now installs `cn` (shadcn's compiled replacement for
  `clsx` + `tailwind-merge`) and lists `shadcn` itself as a runtime
  dependency, for `@import "shadcn/tailwind.css"`.
- Vite's Lightning CSS pass rewrites `oklch()` to hex plus `lab()`
  fallbacks unless `cssTarget` is set. Set it to Electron's Chromium.
- Timings on this machine (11 files): `bun check` 0.11 s against `tsc`
  0.29 s; Vite builds 0.4–0.5 s for both.

## Recommendation

**Use Tailwind CSS v4 with shadcn/ui on Base UI, and enforce the design
system with `@shadcn/lint` under oxlint plus TypeScript's variant types.
Do not adopt StyleX.**

Does Tailwind + the lint plugin give us everything StyleX's type safety
grants? **For this app, effectively yes, with three named exceptions.**

1. **The linter catches more styling mistakes than StyleX's types.** StyleX's
   types catch token typos, variant typos, and forbidden overrides on a
   component. They miss unknown properties, invalid values, raw colors,
   inline styles, and SVG colors; only its separate ESLint plugin catches
   some of those, and the compiler checks none of them. `@shadcn/lint` checks
   every class against the real Tailwind build and the real theme. Variant
   typing is equal on both sides, because both are plain TypeScript unions.
2. **The three things StyleX keeps:**
   - _Override limits written into types._ An `xstyle` prop typed with
     `StyleXStyles<{…}>` holds in every editor with no config. `no-restyle`
     gives the same result as policy kept in `.oxlintrc.json`, and gives
     better guidance.
   - _Tokens as code._ Rename and find-references work on StyleX tokens;
     Tailwind tokens are CSS strings.
   - _Deterministic merging at build time._ StyleX settles conflicts when
     it compiles. Tailwind settles them with `cn` at runtime, and nothing
     catches conflicting classes on a plain element.

   For a one-screen dashboard plus a few dialogs, none of these is worth
   hand-building every component.

3. **Components decide it.** The app needs cards, meters, badges, buttons,
   dialogs, menus, tooltips, toasts and probably a table. shadcn/ui gives
   these on Base UI, in source we own. With StyleX we would style Base UI
   ourselves, component by component.
4. **Agents decide it again.** Models write Tailwind fluently, and the
   linter's errors list the exact variants, sizes, tokens and files to use.
   StyleX's errors are correct but give no design guidance.
5. **Bun fits.** `bun install`, `bun check` (same errors as `tsc`, about 2.5×
   faster here) and `bun --bun oxlint` all worked unchanged on the Tailwind
   project. Bun has no linter, so oxlint stays, and with TS 7 the ESLint host
   is out anyway.

Setup to adopt in `apps/desktop`:

- `@tailwindcss/vite` in electron-vite's `renderer.plugins`, and
  `build.cssTarget` set to Electron 45's Chromium.
- `shadcn init -t vite -b base`, with components in
  `apps/desktop/src/components/ui`. Add slopmax's own status tokens
  (`success`, `warning`, and any provider colors) as `--color-*` in
  `@theme inline`, with values in both `:root` and `.dark`.
- `.oxlintrc.json` with `jsPlugins: ["@shadcn/lint"]`, all six rules at
  `error`, and `no-restyle: { allow: ["layout"] }` plus contracts as needed.
  Turn `no-restyle`, `no-arbitrary-values` and `require-static-classes` off
  in `components/ui/**`, and add `deny: ["*-white", "*-black"]` to
  `no-raw-colors`.
- In `AGENTS.md`/CONVENTIONS: "after UI changes run `bun run lint` and
  `bun check`; fix every error; never add `oxlint-disable` for `shadcn/*`
  rules". Enforce that last rule with a grep in CI.
- Type every component variant with cva `VariantProps`, or with string
  unions that the linter can read too.

## Risks

- **The lint plugin is young.** `@shadcn/lint` is 0.x and six weeks old, with
  nine releases so far. Rule names and options may change. Pin the exact
  version.
- **Oxlint JS plugins are alpha.** If they break, the fallback is ESLint,
  which needs a side-by-side TypeScript 6 for `@typescript-eslint/parser`
  until it supports TS 7. Pin oxlint, and keep the lint config small.
- **Lint is not types.** Findings appear only where oxlint runs (CLI,
  editor extension, CI), and a disable comment silences them. Run lint in CI
  as a gate, not as advice.
- **Known gaps:** conflicting utilities, on-scale but off-design steps
  (`m-13`), and semantic token misuse all pass. Reviews still need to catch
  these. If spacing drift appears, `no-restyle`/`no-arbitrary-values`
  `deny` patterns can narrow it.
- **First-run noise.** The defaults flagged our own correct code (spacing on
  `CardContent`). Expect a short round of tuning contracts before the
  linter's output is trusted.
- **Runtime merge cost.** `cn` adds about 26 kB minified. It is irrelevant
  for a local Electron renderer; if it ever matters, `cn/vite` claims to
  compile it smaller (not measured).
- **Tailwind's source scanning.** Tailwind generates CSS for any class
  string it finds in scanned files, not only in what the app imports. In the
  prototype, a lint fixture inflated the CSS until it was moved out.
  Keep fixtures out of the scanned tree, or add `@source not`.
- **If we ever need StyleX's guarantees,** the move is cheap at this size.
  The app is a handful of components, and `tailwind-to-stylex` exists. The
  decision is reversible.
