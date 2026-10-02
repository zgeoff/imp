# Tokens and identities

Every call to impd runs as someone: a token, the dashboard session made with one, an SSH key, or a
tailnet member. Each has a scope, and it can be limited to some imps.

## The root token

impd makes the root token on its first start and keeps it in `<dataDir>/token`
(`/var/lib/imp/token`), readable by the owner only. It has every scope on every imp, and it is not
in the token list: `imp token rm` cannot remove it. To change it, stop impd, delete the file and
start impd again. A new root token ends every dashboard session.

## Scopes

Scopes nest: `manage` includes `exec`, and `exec` includes `read`.

| Scope    | What it may do                                                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`   | List and read: imps, URLs, egress policies, checkpoints, sessions, services, images, secrets (names and grants only), networks, the audit logs, the event stream, `imp info`, and the backup list for a token with no imp patterns.                                                            |
| `exec`   | Run things in imps: `imp exec`, `imp console`, `attach`, `imp proxy` and its reverse forwards, and ticket requests for the dashboard console. Start, stop, sleep, wake and hold an imp, and take its [leases](./leases.md); kill a session; add, restart and remove a service, and `imp logs`. |
| `manage` | Create, destroy and fork imps; resize a disk; set an egress policy; `imp set` CPU limits and HTTP port; checkpoints; `imp cp`, to copy files in and out, as root. Host-wide: images, secrets and grants, networks, backups, `imp gc`, and tokens.                                              |

`packages/daemon/src/auth/access-policy.ts` maps every procedure to its scope. The map covers every
path of the API contract, so a new procedure without an entry fails the typecheck, and impd refuses
a path with no entry to every caller. A refused call fails with `FORBIDDEN`.

## Imp patterns

A token can be limited to some imps with patterns: an imp name with `*` for any run of characters,
such as `dev-*`. Such a token:

- touches only the imps its patterns match. A fork needs both the source and the new name to match,
  and so does a create from a [template](./templates.md): the template's source imp must match.
- must name the imp it creates. impd never picks a name for it.
- sees only its imps in lists, in the event stream, in the grants of `imp secret ls`, in
  `imp net ls`, and in both audit logs. Rows of the API audit log that name no imp are hidden from
  it.
- cannot make host-wide calls, whatever its scope: images, secrets and grants, networks, backups and
  tokens. A grant hands a host secret to an imp, so a `dev-*` token could otherwise grant itself any
  secret; a network reaches every imp on it. It cannot pass `--net` to `imp new` either.

A token with patterns still sees host-wide totals. `system.info` shows the RAM budget, use and
reserve, the count of imps, awake and in all, and the storage: used and free space, the reserve, and
the sum of every imp's disk size. A `GovernorDecision` event for one of its imps shows the host's
RAM use and budget. Neither names an imp it cannot see. This is accepted: the totals tell it why a
wake waits.

## Manage tokens

Only a `manage` token with no patterns manages tokens.

```sh
imp token new ci --scope exec --imps 'dev-*'   # prints the secret once, on stdout
imp token ls                                   # names, scopes, imps, SSH keys; never secrets
imp token whoami                               # who impd takes this CLI for
imp token rm ci
```

The secret is `imp_<id>.<secret>`. impd keeps only the SHA-256 of the secret: the secret has 256
random bits, so a slow hash adds nothing. A call finds the token by its id and compares the hash in
constant time. Use the secret as any token: `imp login`, `IMP_TOKEN`, or the dashboard's login.

The dashboard has a **Tokens** page for a `manage` token with no patterns. It shows the secret of a
new token once, with a copy button.

Removing a token ends what it opened at once: its dashboard sessions, its event streams, its open
`/exec` and `/tunnel` sockets (close code 1008), the SSH logins made with its keys, and exec tickets
it asked for that are not used yet.

## Each way in

| Way in                   | Runs as                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `Authorization: Bearer`  | the token                                                        |
| Dashboard session cookie | the token it logged in with; the audit log says `dashboard`      |
| Exec ticket              | the caller that asked for it; it opens its one imp only          |
| `/exec`, `/tunnel`       | a token or a tailnet identity; each start or tunnel needs `exec` |
| SSH key                  | the key; see below                                               |
| Tailnet peer             | the identity a rule gives it; see below                          |

A wrong bearer token is refused outright: it never falls through to the cookie or the tailnet. An
`/exec` or `/tunnel` socket that a token without `exec` opens is accepted, and each start on it
fails with `FORBIDDEN` over the socket. A refused WebSocket upgrade has no status a client can read.

### SSH keys

A key bound to a token logs in as that token, with its scope and imps; the login needs `exec` on the
imp. Each key in `authorized_keys` gives `exec` and forwards (`ssh -L`, `ssh -R`) on every imp: the
file is the host owner's, like the root token. [Keys bound to tokens](./ssh.md#keys-bound-to-tokens)
covers binding, moving keys out of the file, and `IMP_SSH_AUTHORIZED_KEYS`.

### MCP

`imp mcp` calls impd with the CLI's token, so impd enforces that token's scope. Run it with a scoped
token to give an agent a real limit:

```sh
IMP_TOKEN=$(imp token new agent --scope manage --imps 'agent-*') imp mcp --prefix agent-
```

The server's `--prefix` guard stays a convenience. impd's own MCP endpoint, `/mcp`, takes a token
per client instead, and its tools follow that token's scope and patterns: see
[MCP over HTTP](./mcp.md#http).

## Tailnet identity

With `IMP_TAILNET_IDENTITIES` set, a tailnet member reaches the API without a token. impd asks
`tailscale whois` who is behind the connection's address and gives the first rule that matches its
scope and patterns. No rule, no access. Without the variable, every caller needs a token.

```sh
IMP_TAILNET_IDENTITIES='[
  {"match": "user:me@example.com", "scope": "manage"},
  {"match": "tag:ci", "scope": "exec", "imps": ["ci-*"]}
]'
```

| `match`        | Matches                                                         |
| -------------- | --------------------------------------------------------------- |
| `user:<login>` | the nodes of that user, by login name                           |
| `tag:<tag>`    | a tagged node with that tag; a tagged node matches by tags only |
| `*`            | any tailnet peer                                                |

The identity is named by the user's login, or by the node's name for a tagged node. impd keeps each
whois answer for a minute.

The address must be the client's own:

- Only an address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48` is asked about. `setup-net.sh` drops
  packets from those ranges that do not come in on `tailscale0`, as tailscaled itself does, so no
  other network can claim one. impd refuses an `IMP_SUBNET` that overlaps `100.64.0.0/10`.
- The node's own tailnet addresses are no peer. That rule lets packets from local addresses pass, so
  an imp's traffic out through the node, or impd's own, would otherwise get the node's tags.
- Over the [HTTPS domain](./https.md), the wake proxy calls the API on loopback. It hands the
  client's address over in-process: it registers the address and sends the API a random handle in
  `x-imp-peer`, which the API redeems once, and only from a loopback peer. The proxy removes any
  `x-imp-peer` a client sends, on every route. `x-forwarded-for` never counts.

A tailnet identity is ambient: a browser on that machine sends it with every page's requests, as it
would a cookie. So impd takes it only when:

- the `Host` names impd: loopback, the node's MagicDNS name or short name, its tailnet addresses
  (IPv4 and IPv6), or the domain. A page on a name of its own that resolves to impd (DNS rebinding)
  is refused.
- the request comes from impd's own origin, or from a client that is not a browser (no `Origin`). A
  page on an imp's port is another origin and is refused, on `/rpc`, `/exec` and `/tunnel` alike.

The dashboard needs no login for a tailnet member a rule matches.

## Tests

- `packages/daemon/src/auth/access-policy.test.ts`: every contract path has a rule.
- `packages/daemon/src/build-app-tokens.test.ts`: every procedure refuses a token whose scope is too
  low, and every host-wide one a token with patterns. It also covers patterns, the event stream,
  sockets, tickets, revocation, the peer handle and cross-site sockets.
- `packages/daemon/src/auth/authenticate.test.ts`: sessions, a rebound host and an imp's page.
- The `tokens` e2e suite drives it all through the CLI. The `tailscale` suite reboots impd with a
  rule and calls the API over the tailnet without a token.
