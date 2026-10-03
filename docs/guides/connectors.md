# Credential connectors

A coding agent in an imp needs API tokens for GitHub, Anthropic or npm. If the guest holds them,
anything that runs there can read them and send them anywhere. With connectors, impd holds the
token. You grant it to an imp, and a broker on the host adds it to the imp's requests for that
service. The guest holds only a placeholder, and so do its disk, its memory snapshots, its
checkpoints and its forks.

```sh
imp secret add gh --kind github      # paste the token at the prompt, or pipe it in
imp grant box gh
imp exec box -- gh api user          # works; the token never enters the guest
imp exec box -- git push             # also works, over https://github.com
imp audit box                        # what the broker sent with the token
imp revoke box gh
```

Fly's [tokenizer](https://github.com/superfly/tokenizer) and
[Deno Sandbox](https://docs.deno.com/sandbox/security/) use the same pattern. Modal, e2b and Daytona
put secrets into the sandbox as environment variables.

## Secrets and grants

| Command                               | What it does                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imp secret add <name> --kind <kind>` | Stores a secret. The value comes from stdin or a prompt that does not echo, never from a flag.                                                                        |
| `imp secret add <name> ... --replace` | Replaces the value of a secret that exists, for a rotation. Other hosts or headers need `--rebind` too ([rotate or rebind](#rotate-or-rebind)).                       |
| `imp secret ls`                       | Lists each secret's kind, hosts and imps. It never shows a value.                                                                                                     |
| `imp secret rm <name>`                | Deletes a secret and revokes it from every imp.                                                                                                                       |
| `imp grant <imp> <secret>`            | Lets the imp use the secret.                                                                                                                                          |
| `imp revoke <imp> <secret>`           | Takes it away. A request under way finishes; every later one fails, on any connection.                                                                                |
| `imp grants <imp>`                    | Lists the secrets granted to the imp.                                                                                                                                 |
| `imp audit [imp] [--limit n]`         | Lists the requests the broker sent with a credential, newest first. `--kind api` lists the calls that changed impd instead ([events](./events.md#the-api-audit-log)). |

A secret name has the same form as an imp name. The value must be printable ASCII without spaces,
which every API token is. An imp may hold one credential per host, so two grants that cover the same
host conflict. impd checks for the clash and makes the grant in one transaction, so two grants at
once cannot both pass. A fork gets the grants of its source, as it gets the disk, less any that
would clash with a grant the fork has by then; impd logs each one it skips. `imp rm` takes the imp's
grants and audit rows with it.

Grants are host-wide: only a `manage` token with no imp patterns makes them, unless the token was
given a list of secrets to grant to its imps ([granting secrets](./tokens.md#granting-secrets)).

The broker decides each request on its own: it looks up the grant, the rule and the value file when
the request arrives, not when the connection opens. After a revoke, the broker stops the terminator
for that imp and host. A request already under way on it finishes, then its connections close, and
the next request opens a new one: a plain tunnel, with no credential. A request that reaches a
terminator between the revoke and its stop finds no grant and gets a 403
`no credential is granted for <host>`.

### Rotate or rebind

A secret's binding is its kind and its rules: hosts, headers, schemes and users. impd compares them
in host order, so the same rules in another order are the same binding.

- `--replace` with the same binding is a rotation. Only the value changes; grants and the
  [grantable lists](./tokens.md#granting-secrets) of tokens keep working.
- `--replace` with another binding fails with `CONFLICT`, `data.reason` `binding_changed`, and
  changes nothing. With `--rebind` (`rebind: true`), impd revokes the secret from every imp in the
  same transaction and gives it a new generation. The answer says how many grants it dropped
  (`droppedGrants`). Grant it again where it belongs; a token's list entry from before the rebind no
  longer covers it.

Each grant records the secret's generation, and the broker uses a grant only while the two match.

A preset's hosts are part of its binding. If a later impd changes the hosts of a preset such as
`github`, a plain `--replace` of a secret of that kind fails with `binding_changed`; add `--rebind`.

The split between rotation and rebind needs impd 0.27.0 or later. An older impd drops `rebind`
unread, takes a changed binding with a plain replace, and keeps every grant. Before a client sends
`replace` or `rebind`, it checks that `system.info()` has `features.secretRebind`.
`imp secret add --replace` does that check, with or without `--rebind`, and against an older impd it
fails before it stores anything.

### Value files

Each value is a file of its own, named `<name>.<random>`, that impd never writes again. The secret's
row names the file, and a replace or a rebind switches the row to a new one in the transaction that
changes the rules. A request reads the row and then exactly that file: it gets the old rules with
the old value, or the new with the new. If the file is gone by then, the request gets no credential
(a 403); the broker never falls back to another file.

impd removes the file a replace or a delete displaced once the transaction commits, and only that
file, so a deleted secret's value does not stay on disk. A failed commit removes its new file and
leaves the old one in place.

At start, impd never deletes a value file that no row names. It moves each one, temp files a crash
left included, into `<data>/secrets/.orphaned/<start time>/` (mode 0700) and logs
`impd: broker: kept secret value file <file>, which no database row names, in <dir>`. Such a file is
the value of a secret added after the database copy a restore put back, a write whose row never
came, or a file a removal failed to delete. impd does not read these files again and never removes
them: check each one, add back with `imp secret add` any value you still need, then delete the
directory.

### Restores

- A checkpoint restore, a sleep and a wake keep the grants the host has now: a grant revoked or
  rebound after the checkpoint stays gone.
- A backup restore still re-creates the grants a backup lists, as fresh host-authorized grants
  against the current secrets: each one takes the secret's generation now and passes the clash
  check. A grant revoked after the backup is created again, so revoke it again if needed.
- Restoring the whole host database rolls back revocations. imp has no anti-rollback mechanism. The
  values of secrets added after the copy are kept aside at the next start
  ([value files](#value-files)), not deleted.

### Kinds

| Kind        | Hosts and headers                                                                                                            | Placeholder variables      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `github`    | `github.com`: `Authorization: Basic` for `x-access-token` (git over HTTPS); `api.github.com`, `uploads.github.com`: `Bearer` | `GH_TOKEN`, `GITHUB_TOKEN` |
| `anthropic` | `api.anthropic.com`: `x-api-key`                                                                                             | `ANTHROPIC_API_KEY`        |
| `npm`       | `registry.npmjs.org`: `Bearer`                                                                                               | `NPM_TOKEN`                |
| `custom`    | `--hosts a.example.com,b.example.com`, with `--header` (default `authorization`), `--scheme bearer\|basic\|raw` and `--user` | none                       |

Some tools refuse to run without a token: `gh` with none stops at `gh auth login`. So the guest gets
the placeholder variables, set to `imp-broker-placeholder`. The broker drops whatever the guest
sends in the header and sets the real value.

## How it works

```text
 guest (10.66.0.2)                        host container
 ┌───────────────────────┐   CONNECT     ┌──────────────────────────────────────────────┐
 │ curl, git, gh, node   │──────────────►│ broker front, 10.66.0.1:7081                 │
 │ HTTPS_PROXY=          │   api.github  │  ├─ granted host:443 ─► TLS terminator       │
 │  http://10.66.0.1:7081│   .com:443    │  │   (imp, host) on a unix socket, leaf from  │
 │ SSL_CERT_FILE=        │               │  │   the host CA, header set, then HTTPS     │──► api.github.com
 │  /etc/imp/broker-ca.pem               │  └─ any other host ─► plain tunnel           │──► example.com
 └───────────────────────┘               └──────────────────────────────────────────────┘
```

1. **The front port.** The broker listens on `IMP_BROKER_PORT` (default 7081) in the host container.
   Each guest reaches it on its own gateway address. The broker finds the imp from the connection's
   two ends: the peer must be a slot's guest address, and it must have dialled that slot's gateway.
   A guest that dials another imp's gateway gets nothing. Strict reverse-path filtering on the taps
   stops a guest from sending with another imp's address.
2. **Granted hosts.** A `CONNECT` to port 443 of a host that a grant covers goes to a TLS terminator
   for that imp and that host. It is a Bun server on a unix socket in `<data>/broker/run`, with a
   leaf certificate for the host. The terminator sends the request to `https://<host>` plus the
   request's path. It never takes the host from the `Host` header or from the request line, and it
   refuses a `Host` header for another name. Responses come back as they are, compressed or not, and
   a redirect goes back to the guest.
3. **Other hosts.** A `CONNECT` to any other host is a plain TCP tunnel, with no TLS termination and
   no credential. The broker resolves the name once, checks every answer, and dials the address it
   checked, so a DNS rebind cannot swap it. It refuses loopback, private, shared (`100.64/10`, which
   holds the tailnet), link-local, multicast and reserved ranges, the
   [blocked IPv6 ranges](../architecture/networking.md#blocked-ranges), and every address of the
   host container. It dials IPv6 only when the host gives imps IPv6. Without these checks, a tunnel
   would start inside the host container and reach impd's API, the wake proxy and other imps' ports.
   The imp's [egress policy](../architecture/networking.md#egress) decides which hosts get a tunnel:
   `open` any, `box` those its list allows, `none` none. A tighter policy closes the tunnels it
   denies.
4. **The guest's variables.** Every exec in an imp with a grant, and every command, shell and SFTP
   server that the [SSH gateway](./ssh.md) starts, gets `HTTPS_PROXY` and `https_proxy`, `NO_PROXY`
   for loopback, `NODE_USE_ENV_PROXY=1`, and `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`,
   `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE`, all pointing at
   `/etc/imp/broker-ca.pem`. Variables the caller sets win. impd adds these on the host side, so the
   agent protocol does not change.
5. **The CA bundle.** Before the first exec of each boot or wake, impd runs one exec as root that
   builds the bundle in the guest: the guest's own root bundle (`/etc/ssl/certs/ca-certificates.crt`
   or the distro's path, CAs the guest added included) plus the broker CA. A guest with no root
   bundle gets the host's roots instead. The exec leaves the file alone when it already holds that
   bundle. If it fails (an image with no `/bin/sh`), that exec runs without the broker's variables
   instead of with a CA nothing trusts, impd logs why, and the next exec tries again.

### One CA for the host

The issue asked for a CA per imp. impd uses one CA for the host instead. impd holds every CA key
either way, so a CA per imp would isolate nothing. One CA also needs no lifecycle: a fork, a restore
and a wake keep a CA they still trust. The per-imp boundary is the terminator: each (imp, host) pair
has its own server, and it serves only the credential granted to that imp. The CA is
`<data>/broker/ca/ca.pem`, with its key in `ca.key` (0600, in a 0700 directory). Leaves last one
year and are issued again 30 days before they end. Each leaf has a SAN, `serverAuth` and the CA's
key id, so strict verifiers such as Python 3.13 accept it.

## Where secrets are

| Place                            | What is there                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<data>/secrets/<name>.<random>` | The value, mode 0600 in a 0700 directory, written by a temp file and a rename ([value files](#value-files)); an older impd's file is `<name>`. Never in an imp's disk, snapshot or backup. |
| The database                     | The name, kind, hosts and grants. Never a value.                                                                                                                                           |
| The API, the CLI, logs           | Never a value. A failed `imp secret add` logs the error but not the value.                                                                                                                 |
| The guest, its snapshots         | The placeholder and the public CA bundle only.                                                                                                                                             |
| `imp audit`                      | Time, imp, secret, method, host, path without the query, status, bytes, time.                                                                                                              |

Values are not encrypted at rest: the key would sit on the same disk. The audit log keeps the newest
1000 rows per imp.

## Limits

- Tools that ignore `HTTPS_PROXY` do not reach the broker. Node's own `fetch` follows it only with
  `NODE_USE_ENV_PROXY=1`, which the exec sets; an older Node ignores it.
- Tools with their own trust store work only through the variables above. A static binary with
  pinned roots, or a Java keystore, does not trust the broker CA.
- Only an exec started after the grant gets the variables. impd adds them when it starts an exec, so
  these processes run without the broker:

  | What                                              | How to get the variables                                                                                                                                                         |
  | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Services in `/etc/imp/services.d`                 | The agent starts them, not impd. Put the variables in the service's `env` (`imp service add --env`, [services](./services.md)); `imp exec box -- env` prints the values to copy. |
  | A session started before `imp grant`              | `imp attach` joins the process as it started. Start a new session, or exit the shell and open `imp console` again.                                                               |
  | An exec or SSH command started before `imp grant` | The same: start it again.                                                                                                                                                        |

- The terminator serves HTTP/1.1 only, so clients fall back from HTTP/2. WebSocket upgrades to a
  granted host are not supported.
- A host takes exact names: no wildcards, and no IP addresses.
