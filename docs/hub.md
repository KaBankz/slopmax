# Other machines

Keep your accounts on one machine, the hub, and point your other machines at it. Refresh tokens rotate each time they are used, so two machines that each refresh the same login sign each other out. With a hub, only the hub refreshes each login, and your other machines hold no tokens at all.

## Over Tailscale

If your machines are on the same [Tailscale](https://tailscale.com) tailnet, publish slopmax to it from the machine with the accounts:

```sh
slopmax tailscale on
```

It runs `tailscale serve` for you, and the proxy itself keeps listening on 127.0.0.1 only. The tailnet needs HTTPS certificates turned on (DNS in Tailscale's admin console). On Linux, Tailscale lets only root change what a machine serves, so allow your user once first:

```sh
sudo tailscale set --operator=$USER
```

slopmax never runs sudo itself. Tailscale sends your machines' requests to the proxy's port under a private path, made from slopmax's owner key, which Tailscale alone is told; a request that comes under it, from Tailscale's own process, is your tailnet's. Then, on each of your other machines:

```sh
slopmax setup --hub <machine>   # the hub's name on your tailnet, or its URL
```

Claude Code and Codex there now use the hub's accounts. No proxy runs on those machines, and `slopmax setup --hub off` goes back to their own. On a new machine, `slopmax setup` offers a hub it finds on your tailnet.

Tailscale tells the hub which machine is asking, so your own machines need no key. What a machine may do depends on two lists on the hub:

- **Users** (`slopmax tailscale user add <login>`): machines signed in as these tailnet logins use the proxy and see slopmax's status, usage, and history. `slopmax tailscale on` adds your own login.
- **Admins** (`slopmax tailscale admin add <machine>`): these machines may also manage slopmax: accounts, sign-ins, settings, and keys. There are none at first. Each is matched by Tailscale's stable node id, so another machine signed in as you does not become an admin.

List only your own logins. The hub is for your own machines.

When the hub is down, agents on your other machines fail. They don't fall back to accounts of their own, because that would bring the sign-outs back.

Some machines need a key: tagged machines, which Tailscale doesn't tie to a login, and every machine when the hub is published with `--loopback`, where Tailscale can't tell slopmax who is asking. Make one on the hub, then give it to setup:

```sh
slopmax key add ci                                                        # on the hub; prints the key
slopmax setup --hub https://hub.example.ts.net:7567 --hub-key <the key>   # on the other machine
```

slopmax serves your tailnet, never the internet: `tailscale on` won't publish a port Tailscale Funnel exposes, and the hub refuses every request that comes through Funnel, even with a key.

Any user of the hub can ask Tailscale for the private path. On Linux slopmax also checks that a request under it came from root (Tailscale) or you, so another user of the machine can't pass for your tailnet; on macOS and Windows the path alone decides, so keep a hub there to yourself, or publish it with `--loopback`. `slopmax tailscale on --socket` instead serves an owner-only socket, which Tailscale lets only root publish: it prints the `sudo tailscale serve` command to run once, then picks up from there.

The Docker image has no Tailscale. Run `tailscale serve --bg --https=7567 http://127.0.0.1:7567` on the host or in a Tailscale sidecar container; every machine then needs a key.

`slopmax tailscale status` shows where slopmax is published and who may use it, `slopmax tailscale off` stops publishing it, and `slopmax doctor` checks the setup.

## Over your network

Without Tailscale, set `listen = "0.0.0.0:7567"` to serve your network, and give each machine or tool its own key, so you can revoke them one at a time:

```sh
slopmax key add laptop                    # prints the new key
slopmax key add ci --models 'gpt-*'       # a key limited to some models
slopmax key remove laptop
```

On the other machine, `slopmax setup --hub http://<hub address>:7567 --hub-key <the key>` points its agents at the hub. Plain http works only with a key; use it only on a network you trust.

Client keys can use the proxy but not slopmax's own API, and `slopmax doctor` notes when the proxy listens beyond this machine.
