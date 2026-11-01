# Rust vs TypeScript: the comparison harness

The scripts behind [`ts/docs/VERDICT.md`](../../ts/docs/VERDICT.md). Linux only (memory and CPU come
from `/proc`); they need `oha`, `jq` and `hyperfine` (mise: `oha@1.16 jq@1.8 hyperfine@1.20`), and the
desktop script needs Xvfb, `xwininfo` and ImageMagick's `import`. Every process under test gets a
throwaway home, and the ports are 9210-9231, never 8317.

Build first, from the repository root:

```sh
cargo build --release --locked --bin slopmax --example bench     # Rust CLI and its bench rig
cargo build --release --locked -p slopmax-desktop-gpui           # the GPUI app (about 11 minutes)
B=~/.cache/slopmax-compare && mkdir -p "$B"                       # binaries outside the tree
(cd ts && mise run compile) && cp ts/apps/cli/dist/slopmax "$B/slopmax-aot"     # the shipped AOT CLI
(cd ts && mise run build) && cp ts/apps/cli/dist/slopmax "$B/slopmax-fallback"  # the --no-aot fallback
(cd ts && mise exec github:oven-sh/bun@canary -- bun ../scripts/compare/build-ts.ts "$PWD" "$B")  # TS rig and raw probe
(cd ts/apps/desktop && bun package.ts --cli "$B/slopmax-aot" --out "$B/desktop" --archive)
```

Then, with `<bin>` being `$B`:

| Script | Measures |
| --- | --- |
| `compare.sh <repo> <bin> <out> [rounds] [seconds]` | Both proxies and the Bun raw probe behind one mock (the Rust rig's), the same oha loads interleaved per round, CPU per request from `/proc`, memory idle and after. `PROXY_CPUS=0` pins the proxies to one CPU; `ONLY=c32` and `TARGETS="rust ts"` narrow the run. |
| `startup.sh <repo> <bin> <out>` | Binary size and xz size, `--version` and `status --json` (hyperfine, 100 runs), `serve` until `/healthz` (20 runs), the shipped daemon's idle memory. |
| `desktop.sh rust\|ts <repo> <app> <out>` | One desktop app under Xvfb against its own demo daemon: time to the first visible window, PSS over every process, idle CPU, a screenshot. |
| `probe-rust.sh <rust bench rig>` | strace syscall counts for 1000 sequential requests through the Rust proxy. |
| `loc.py <repo>` | Code lines (not blank, not comment) per component, product and tests apart. |
