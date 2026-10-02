# Tailscale

The host container joins the tailnet as one node, tagged `tag:imp`. Every imp is reachable through
that node on its own port. [Networking](../architecture/networking.md#urls) covers the URLs, and
[configuration](./configuration.md#host-container) lists the variables.

## How it works

`host/scripts/tailscale-up.sh` runs inside the host container. The key comes from
`TAILSCALE_AUTHKEY`, or from the file `IMP_TAILSCALE_AUTHKEY_FILE` names (the
[NixOS module](./nixos.md#the-tailscale-key) mounts one). With neither a key nor saved node state it
does nothing. Otherwise it:

1. Replaces `/etc/resolv.conf` with public resolvers (`IMP_DNS`, default `1.1.1.1,8.8.8.8`) if it
   points at `100.100.100.100`. See [DNS](#dns).
2. Starts `tailscaled` in kernel TUN mode (`tailscale0`) unless one already runs. The container is
   privileged and has its own netns, so the TUN device and routes never touch the host.
3. With saved state, waits up to 15 s for the saved node to be `Running`. If it is, it skips the
   login and never uses a key, which would make a second node; `deploy/bootstrap.sh` blanks the key
   once the node has joined. If the saved node needs a login instead (`NeedsLogin`: it logged out,
   or Tailscale deleted it after a long time offline), it goes on to step 4 with the key, and fails
   without one.
4. Runs
   `tailscale up --auth-key=file:... --hostname=${IMP_TAILSCALE_HOSTNAME:-imp} --advertise-tags=tag:imp --accept-dns=false --reset`.
   The key goes through a 0600 temp file, or the key file itself, so it never shows in argv. A node
   that runs from saved state under another hostname logs in again only when there is a key.
5. Waits for `Running` and prints the tailnet IP and MagicDNS name.

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
Tailscale's choice, not ours, and a reinstall can take that long. After that, the saved state is
dead: `tailscale-up.sh` sees `NeedsLogin` and joins again with the key, which registers a fresh node
with a new IP (and the old name, if it is free). Without a key the node stays off the tailnet.

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

## Per-imp names

With `IMP_TAILNET_NAMES=1`, each imp also gets a name of its own on the tailnet,
`https://<name>.<tailnet>.ts.net` and `http://` the same, with no port. impd makes each name a
[Tailscale Service](https://tailscale.com/kb/1552/tailscale-services): a virtual IP and a MagicDNS
name that this host serves. It is off by default.

**CAUTION:** Per-imp names have not run against a live tailnet yet. Before anyone turns
`IMP_TAILNET_NAMES` on, run the live test once with the OAuth client
([development](./development.md#end-to-end-tests)), and replace the unit tests' fake API answers and
`tailscale serve status` output with what the live run returned for a name a device holds and for a
served name.

**NOTE:** [A domain of your own](./https.md) is the recommended way to give imps names. It needs no
API credential, puts no name in the tailnet's service list, and one wildcard certificate covers
every imp. Use per-imp names when you have no domain to give impd.

### What it needs

Tailscale v1.86 or later on the host (the image's is newer), and on the tailnet:

1. The tag `tag:imp-svc`, which tag:imp and admins may set, a rule that lets tag:imp hosts serve
   services that carry it, and a grant that lets members reach them:

   ```json
   {
     "tagOwners": { "tag:imp-svc": ["tag:imp", "autogroup:admin"] },
     "autoApprovers": { "services": { "tag:imp-svc": ["tag:imp"] } },
     "grants": [{ "src": ["autogroup:member"], "dst": ["tag:imp-svc"], "ip": ["80", "443"] }]
   }
   ```

   The autoApprovers form is the documented one. A grant to a service tag is the documented way to
   reach services; that it covers each service's virtual IP is documented, not yet tested live.
   Tailscale's docs do not say which tag owner a service made through the API needs, so admins own
   the tag too.

2. An OAuth client with the `services` scope and nothing more, and the tag `tag:imp-svc`. impd
   defines and deletes the services with it.
3. HTTPS certificates turned on for the tailnet, for the `https://` names.

**CAUTION:** The `services` scope reaches every service on the tailnet, not only impd's. impd
changes only services it made (see [ownership](#ownership)), but the secret can change any of them.
Keep it in a file only root can read, and give it no other scope.

### Set it up

1. Write the client to a file, mode 0600:

   ```sh
   mkdir -p /var/lib/imp/tailnet-names
   install -m 600 /dev/null /var/lib/imp/tailnet-names/oauth.json
   cat > /var/lib/imp/tailnet-names/oauth.json <<'JSON'
   {"clientId": "<client id>", "clientSecret": "<client secret>"}
   JSON
   ```

   impd reads it each time it needs a token, so the secret is never in its env, in `imp info` or in
   a log line. A file that group or others can read is refused. `IMP_TAILNET_OAUTH_FILE` moves it.

2. Set `IMP_TAILNET_NAMES=1` in the host's env file and restart the host container.
   `IMP_TAILNET_NAME_PREFIX` puts a prefix on every name, for example `imp-` for `imp-box`.

3. `imp url <name>` prints the name once it works, after the https URL of a domain and before the
   others. `imp info` counts the live names and lists each one that failed, with the reason.

### What impd does

- A pass runs at start, after every create and destroy, and every 10 minutes. It reads the tailnet's
  services, then for each imp:
  1. Reads the service again just before any write. If one by that name exists and is not this
     host's, impd never overwrites it: that imp's name fails with
     `svc:<name> exists and this host does not own it`. The API has no conditional write, so a
     service someone makes in the moment between that read and the write is overwritten.
  2. Writes the service, `svc:<prefix><imp>`, with ports `tcp:80` and `tcp:443`.
  3. Serves it with `tailscale serve --service`, HTTP on 80 and HTTPS on 443, both to the imp's own
     port on loopback. That port wakes a sleeping imp, as a tailnet request to it does.
- For a service of this host's that no imp has any more, it takes the imp's lock, checks that no imp
  has the name, then runs `tailscale serve clear` and deletes the service. There is no
  `tailscale serve drain` first: the imp is gone, so no connection through it is left to finish.
- Serve config for a service that is gone from the tailnet is cleared.
- A failure (the API, a name a device holds, a missing policy) fails that name only. It never fails
  the create, and the next pass tries again.

A request through a name reaches the imp like any other on its port: the Host header is the name,
`X-Forwarded-For` is the member's tailnet IP, and `Tailscale-User-Login` names the member. It can
never reach impd's API, whatever its Host says.

### Ownership

A service is this host's when it has the tag `tag:imp-svc` and the comment `imp host <id>`. The ID
is in `<data>/tailnet-names/host-id`, made on first use. It lives in the data dir, not in the node,
so a node that registers again under an ephemeral key still owns its services. A second imp host on
the tailnet has its own ID and never touches the first one's services.

If the host-id file is lost (a wiped data dir, a restore without it), impd makes a new ID, and every
name fails with `exists and this host does not own it`: the services still carry the old one. To
recover, take the old ID from any of the services' comments (the Services page of the admin
console), write it back, and restart the host container:

```sh
printf '%s\n' '<old id>' > /var/lib/imp/tailnet-names/host-id
chmod 600 /var/lib/imp/tailnet-names/host-id
```

Or delete those services in the admin console; the next pass makes them again with the new ID.

### Limits

- Each name gets its own Let's Encrypt certificate on first HTTPS use, and every certificate is in
  the public Certificate Transparency logs. Anyone can read the names of your imps there, with your
  tailnet's name.
- Let's Encrypt allows 50 new certificates a week for each registered domain, and each
  `<tailnet>.ts.net` counts as one. Many new imps in a week, or other HTTPS names on the tailnet,
  can reach it; the first HTTPS request to a new name then fails until the week rolls on. Plain
  `http://` keeps working.
- A service cannot take a name a device already has. That imp's name fails; set a prefix.

## Limits

- No wildcard MagicDNS names, so no `<name>.imp.<tailnet>.ts.net`. Per-imp URLs on the tailnet are
  per-port, unless you give impd a domain of your own ([HTTPS](./https.md)) or turn on
  [per-imp names](#per-imp-names).
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
sleeps the imp and checks that a tailnet request wakes it. The key comes from `TAILSCALE_AUTHKEY`,
then 1Password (`op read` with a 20-second limit, reference in `IMP_TAILSCALE_AUTHKEY_REF`; the
harness turns this on only for runs that include this suite), then `.env`, as for `scripts/dev.sh`.
Without one the suite skips, except in the `acceptance` set, where it fails.
`scripts/test-e2e.sh --clean` logs the node out with `tailscale-down.sh` before it wipes the
instance.
