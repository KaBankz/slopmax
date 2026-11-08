# Performance harness

The scripts behind the measurements in `ARCHITECTURE-NEXT.md`. Linux only (memory and CPU come from
`/proc`); they need `oha`, `jq` and `hyperfine` (mise: `oha@1.16 jq@1.8 hyperfine@1.20`). Every
process under test gets a throwaway home, and the ports are 9210-9231, never 8317.

Build the CLI and its bench rig first, from the repository root, and keep binaries outside the tree:

```sh
cargo build --release --locked --bin slopmax --example bench
B=~/.cache/slopmax-perf && mkdir -p "$B" && cp target/release/examples/bench "$B/bench-head"
```

| Script | Measures |
| --- | --- |
| `ab.sh <rig a> <rig b> <out> [rounds] [seconds]` | Two bench rigs (two commits) behind one mock, the same loads interleaved, CPU per request, idle memory, threads and wake-ups: the gate for each phase. `SLOPMAX_WORKERS` passes through to both. |
| `swarm.sh <bench rig> <out> [sessions] [seconds] [body] [pace-ms]` | Many agents at once (300 by default, as 10 Claude Code sessions with 30 subagents make): each streams answers back to back, the mock paced like a model, through the mock alone, `bench raw` (a bare forwarder on the same HTTP stack, slopmax's floor), and the proxy with each runtime in `WORKERS` (default `1 auto`). Reports what each adds to the first byte and to each event's lag, and the proxy's CPU. `SWARM_GPT_EVERY=10` has every tenth session ask for a GPT model, which the proxy translates. |
| `probe-rust.sh <bench rig>` | strace syscall counts for 1000 sequential requests through the proxy. |
