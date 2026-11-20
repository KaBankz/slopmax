# Installing and updating

## Linux and macOS

The install script fetches the latest release for your machine, checks its SHA-256, and puts `slopmax` in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/install.sh | sh
```

`SLOPMAX_VERSION` picks a release (`SLOPMAX_VERSION=v0.18.2`; the default is the latest), and `SLOPMAX_INSTALL_DIR` picks where the binary goes. Pass them to `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/install.sh | SLOPMAX_INSTALL_DIR=/usr/local/bin sh
```

Prebuilt binaries cover x86_64 and arm64 on Linux (static, so any distribution) and macOS.

## Windows

Download `slopmax-x86_64-pc-windows-msvc.zip` (or the `aarch64` one) from the [latest release](https://github.com/KaBankz/slopmax/releases/latest). Keep its two programs together in a folder on your `PATH`: `slopmax.exe`, and `slopmaxw.exe`, which runs the proxy at login.

## mise

```sh
mise use -g github:KaBankz/slopmax
```

## Cargo

With Rust 1.91 or newer:

```sh
cargo install --locked --git https://github.com/KaBankz/slopmax slopmax
```

This builds slopmax without its web dashboard, which takes Bun to build; `slopmax dashboard` then says so, and the terminal UI (`slopmax tui`) works as usual. From a checkout, [mise](https://mise.jdx.dev) provides the whole toolchain and builds the dashboard in: `mise install`, then `mise run install`.

A proxy that many clients share can trade memory for throughput by building with mimalloc: add `--features mimalloc`. The Docker image does.

## Docker

Accounts and settings live in the `/data` volume:

```sh
docker build -t slopmax .
docker run -d --name slopmax -p 127.0.0.1:7567:7567 -v slopmax:/data slopmax
docker exec -it slopmax slopmax login codex --device
```

The image has no Tailscale; see [Other machines](hub.md#over-tailscale) to share it.

## Updating

`slopmax update` installs the newest release the way slopmax was installed, then moves the running proxy to it:

- **The install script:** it downloads the release, checks its SHA-256, and replaces `slopmax` where it is.
- **mise:** it runs `mise upgrade`. A version pinned in your global mise config is moved to the new one; a pin in a project's config is left to you.
- **Homebrew, cargo, or Nix:** it prints the command that updates it.

On Linux and macOS, the proxy changes over without dropping anything. The running proxy starts the new binary with its listening socket, and once the new one serves, it stops taking connections and finishes the requests it has, streams and Codex's turns included. New connections go to the new proxy from the first moment, so agents are never refused or cut off. It also follows an update you make another way, such as `mise upgrade` or re-running the install script: within a minute of a newer slopmax being installed, the proxy moves to it. A proxy older than 0.11 can't hand over its socket, so moving from one restarts it once. Windows can't hand a socket over either: there `slopmax update` stops the proxy, and the login service (`slopmaxw.exe`, from `slopmax proxy install`) starts it again at once on the new binary. Without the login service, run `slopmax proxy start` afterwards.

The login service keeps the proxy's listening socket open between one process and the next. systemd keeps it in the unit's file-descriptor store, and launchd owns it outright. New connections can wait about a second for the restarted proxy. A crash can interrupt a request the old process already accepted. On macOS, moving from 0.11 or older writes the login service anew, which restarts the proxy once.

The proxy looks up the newest release once a day, one request to github.com, and `slopmax status` says when one is out. `check_updates = false` or `SLOPMAX_NO_UPDATE_CHECK=1` turns that off; `slopmax update --check` looks now.
