# Development

[mise](https://mise.jdx.dev) pins the toolchain and runs every task, here and in CI:

```sh
mise install       # Rust and Bun, at the versions mise.toml pins
mise run check     # rustfmt, clippy with warnings denied, and the tests
mise run web       # the web UI: format, types, lint, tests, and the contract fixtures
mise run msrv      # builds with the minimum supported Rust (1.91)
mise run budget    # at most 131 crates and a 12 MiB binary
mise run bench     # the latency, throughput, memory, and startup slopmax adds
mise run ui        # build the web UI the binary embeds
mise run build     # optimized release binary
mise run install   # the web UI, then slopmax into ~/.cargo/bin
mise run install-script  # lint install.sh and install the latest release with it, into a scratch directory
mise run demo      # a throwaway slopmax with fake accounts, for working on the dashboard
```

`crates/slopmax-daemon/tests/proxy.rs` runs the proxy end to end against mock providers. [ARCHITECTURE.md](../ARCHITECTURE.md) maps the code, walks through adding a provider, an agent, or an API format, and lists the current numbers.
