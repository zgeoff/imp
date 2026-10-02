# Tailscale

The host container joins the tailnet as one node, tagged `tag:imp`. Every imp is reachable through
that node on its own port. [Networking](../architecture/networking.md#urls) covers the URLs, and
[configuration](./configuration.md#host-container) lists the variables.

## How it works

`host/scripts/tailscale-up.sh` runs inside the host container. It does nothing unless
`TAILSCALE_AUTHKEY` is set. Otherwise it:

1. Replaces `/etc/resolv.conf` with public resolvers (`IMP_DNS`, default `1.1.1.1,8.8.8.8`) if it
   points at `100.100.100.100`. See [DNS](#dns).
2. Starts `tailscaled` in kernel TUN mode (`tailscale0`) unless one already runs. The container is
   privileged and has its own netns, so the TUN device and routes never touch the host.
3. Runs
   `tailscale up --auth-key=file:... --hostname=${IMP_TAILSCALE_HOSTNAME:-imp} --advertise-tags=tag:imp --accept-dns=false --reset`.
   The key goes through a 0600 temp file, so it never shows in argv. If the node is already
   `Running` with the right hostname, it skips this.
4. Waits for `Running` and prints the tailnet IP and MagicDNS name.

`host/scripts/tailscale-down.sh` runs `tailscale logout` and stops `tailscaled`. Logout deletes an
ephemeral node at once. A plain container stop does **not** log out.

ACL: `autogroup:member -> tag:imp:*`. Members reach the host on any port. The host (and so any imp
traffic that leaves through it) cannot open connections to members or to other `tag:imp` nodes.
Replies to member connections pass.

## State and ephemeral keys

State lives in `/var/lib/imp/tailscale` (`IMP_TAILSCALE_STATE_DIR`; `mem` keeps it in memory).

The current key is ephemeral. We still persist the state, because the name matters more than the
node lifetime:

- With persisted state, a restart reuses the same node: same IP, same name. Checked: kill
  `tailscaled`, run `tailscale-up.sh` again, the IP does not change.
- With `--state=mem:`, every start registers a new node. The old node stays until Tailscale removes
  it, so the new one becomes `imp-1`, `imp-2` and so on. The URLs change.

The limit: an ephemeral node that stays offline is deleted by Tailscale. The time before that is
Tailscale's choice, not ours. After that, the saved state is dead. `tailscale up --auth-key` then
registers a fresh node with a new IP (and the old name, if it is free).

For a long-lived host, use a non-ephemeral, tagged key, or an OAuth client
(`--auth-key=tskey-client-...?ephemeral=false`). Tagged nodes have no key expiry. Keep the ephemeral
key for smoke tests.

**CAUTION:** Remove a test container without `tailscale-down.sh` and its node stays on the tailnet
as an offline orphan until Tailscale deletes it. The next node with that hostname gets a `-1`
suffix.

impd reports the name the node got (the first label of its MagicDNS name) in `imp info` and uses it
in `imp url`, so the URLs follow a `-1` suffix. The orphan keeps the plain name: `imp` then resolves
to a dead node. Find the node by its IP (`imp info`), not by `HostName`, which both nodes share.

## Tailnet identity

impd can give tailnet members access to its API without a token: `IMP_TAILNET_IDENTITIES` maps
logins and tags to scopes, and impd checks each connection with `tailscale whois`.
[Tokens and identities](./tokens.md#tailnet-identity) covers the rules and how impd keeps them safe.

## URL scheme

| URL                                                  | Routes to                                    |
| ---------------------------------------------------- | -------------------------------------------- |
| `http://imp:<20000+slot>/`                           | the imp in that slot (one listener per slot) |
| `http://imp:7080/` with `Host: <name>.imp.localhost` | Host-header routing, same as local           |
| `http://imp.<tailnet>.ts.net:...`                    | the same, by full MagicDNS name              |

`imp` alone resolves on member devices through the MagicDNS search domain. Both the short name and
the FQDN were checked from WSL and from Windows.

## HTTPS with `tailscale serve`

`tailscale serve` gives HTTPS per port, with a Let's Encrypt cert for the node's FQDN. Checked on
this tailnet (HTTPS certs are on, `CertDomains` lists the node):

```sh
tailscale serve --bg --https=20000 http://127.0.0.1:20000
tailscale serve --bg --https=21000 http://127.0.0.1:20000
```

- Both answer `https://imp.<tailnet>.ts.net:<port>/` from WSL and from Windows.
- Serve takes the port on the tailnet IP even when the backend listens on `0.0.0.0` with the same
  port. Plain HTTP to that port then fails (`Client sent an HTTP request to an HTTPS server`). So a
  port is either HTTP or HTTPS on the tailnet, not both.
- The cert is for one name only. HTTPS works only with the FQDN, not with `imp` or the IP.
- The first request waits for ACME issuance (some seconds). It needs working DNS (see below).
- `--tcp=<port> tcp://127.0.0.1:<port>` forwards raw TCP; `--tls-terminated-tcp=<port>` adds TLS in
  front of a raw TCP backend. Both bypass HTTP, so no Host-header routing.

impd does not use `tailscale serve`. With a domain of your own, impd terminates TLS itself, with a
wildcard certificate, and every imp gets a name instead of a port ([HTTPS](./https.md)). A serve
config on 443 or 80 takes that port before impd sees the traffic, so impd warns about one at start.
Serve config is part of the node state, so it survives restarts with persisted state.

## DNS

Docker copies the host's resolv.conf into the container. On a host that runs Tailscale with MagicDNS
(this WSL machine does), that is `nameserver 100.100.100.100`. A normal container reaches the host's
quad100 through the host. The imp host container runs its own `tailscaled`, which captures
`100.64.0.0/10` in its own netns. With `--accept-dns=false` its quad100 has no upstream, so every
lookup fails, including ACME for `tailscale serve`. `tailscale-up.sh` rewrites resolv.conf in that
case. `scripts/dev.sh` also starts the host container with `--dns 1.1.1.1 --dns 8.8.8.8`.

## Limits

- No wildcard MagicDNS names, so no `<name>.imp.<tailnet>.ts.net`. Per-imp URLs on the tailnet are
  per-port, unless you give impd a domain of your own ([HTTPS](./https.md)).
- One `tailscale serve` cert, one name.
- The host is one node: one IP, one name for all imps.

## Verify reachability

The `tailscale` suite of the end-to-end harness checks the tailnet from this machine, which must be
a member (`tailscale status` reports `Running`):

```sh
scripts/test-e2e.sh --only tailscale
```

It waits for impd's node to come up, checks DNS inside the host container, then fetches an imp by
the node's IP, MagicDNS name and short name, on the imp's own port and on the proxy port. Last, it
sleeps the imp and checks that a tailnet request wakes it. Without `TAILSCALE_AUTHKEY` the suite
skips, except in the `acceptance` set, where it fails. `scripts/test-e2e.sh --clean` logs the node
out with `tailscale-down.sh` before it wipes the instance.
