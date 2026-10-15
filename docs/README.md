<div align="center">
  <h1>impz documentation</h1>

  <p>How impz is built, how to use it, and how to develop and release it.</p>

  <p>
    <a href="./architecture/overview.md">Architecture</a> •
    <a href="#guides">Guides</a> •
    <a href="#runbooks">Runbooks</a> •
    <a href="../AGENTS.md">Agent Guidelines</a>
  </p>
</div>

---

## Architecture

How impz is built: the parts, what each one owns, and what holds whatever a caller does.

- [Overview](./architecture/overview.md) — the path of a request, the topology, the data and the
  rules that cross every part, on one page
- [Isolation](./architecture/isolation.md) — the VM, the jailer, cgroups, the host container, and
  what keeps one imp from another
- [The host](./architecture/host.md) — what the host gives, the container's privileges, the Docker
  socket proxy and the host firewall

### Lifecycle

- [The lifecycle](./architecture/lifecycle/lifecycle.md) — states, the per-imp lock, leases, the
  watchdog, stop and destroy, and recovery after a restart
- [Sleep and wake](./architecture/lifecycle/sleep-and-wake.md) — the snapshot, the wake order,
  snapshot identity, young guests and idle detection
- [The RAM governor](./architecture/lifecycle/ram-governor.md) — the budget, admission, which imps
  it sleeps, refusals and KSM
- [Elastic memory](./architecture/lifecycle/elastic-memory.md) — virtio-mem, the grow and shrink
  controller, the host limit and the limits on a max
- [Boot templates](./architecture/lifecycle/boot-templates.md) — the template key, the build, the
  restore and claim, and the risks a shared template accepts

### Guest

- [The agent](./architecture/guest/agent.md) — the two drives and the kernel, the boot, the inner
  container, execs and services
- [The agent protocol](./architecture/guest/protocol.md) — one request per vsock connection, the
  frames, versions and errors
- [Sessions](./architecture/guest/sessions.md) — sessions that outlive a client, generations, boots
  and offsets, and session logs on the host

### Storage

- [Storage](./architecture/storage/storage.md) — the XFS and ZFS backends, system files,
  checkpoints, restores and forks
- [Disk space](./architecture/storage/disk-space.md) — disk sizes, the disk budget, usage and the
  sweep of orphaned storage
- [Images](./architecture/storage/images.md) — pulls and builds, where builds run, and template
  images made from an imp's disk
- [Backups](./architecture/storage/backups.md) — the restic repository, a backup run, the schedule
  and restores
- [Moves](./architecture/storage/moves.md) — a move between hosts, tickets, warm moves, and the rule
  that keeps one live copy

### Network

- [Networking](./architecture/network/networking.md) — addressing, the base firewall and IPv6
- [Egress](./architecture/network/egress.md) — the egress policies, the firewall table, the resolver
  and private networks
- [Ingress](./architecture/network/ingress.md) — the wake proxy, HTTPS on a domain, public imps,
  tailnet names, SSH and tunnels
- [The credential broker](./architecture/network/broker.md) — grants, the broker's front port, and
  secrets that never reach a guest

### Control

- [The API](./architecture/control/api.md) — the contract, the streams, exec and tunnels, the
  clients, events, audit and telemetry
- [Auth](./architecture/control/auth.md) — callers, scopes, the dashboard session, tailnet identity
  and OAuth

### Where things live

Five areas spread over more than one folder. Each row maps one folder or file to the part it holds
and the doc that explains that part.

| Area           | Code                           | Holds                                                             | Doc                                                                |
| -------------- | ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Broker         | `packages/daemon/src/broker/`  | the front port, the CA, grants, OAuth refreshes and tunnels       | [the credential broker](./architecture/network/broker.md)          |
| Egress         | `packages/daemon/src/egress/`  | the policies, the firewall table and the resolver                 | [egress](./architecture/network/egress.md)                         |
| Tokens         | `packages/daemon/src/token.ts` | the root token                                                    | [auth](./architecture/control/auth.md)                             |
| Tokens         | `packages/daemon/src/auth/`    | scoped tokens, callers, scopes and the dashboard session          | [auth](./architecture/control/auth.md)                             |
| Tokens         | `packages/daemon/src/oauth/`   | the OAuth server and the public MCP route                         | [auth](./architecture/control/auth.md)                             |
| Images         | `packages/daemon/src/images/`  | pulls, builds and template images                                 | [images](./architecture/storage/images.md)                         |
| Images         | `images/`                      | the images that ship with impz                                    | [the images guide](./guides/images.md)                             |
| Images         | `host/Dockerfile`              | the guest kernel and the system drive, as build stages            | [the agent](./architecture/guest/agent.md#two-drives-and-a-kernel) |
| Host lifecycle | `host/`                        | the host image, its entrypoint and its setup scripts              | [the host](./architecture/host.md)                                 |
| Host lifecycle | `deploy/`                      | the server bootstrap, the upgrade, the units and the NixOS module | [install](./guides/install.md)                                     |

## Guides

How to install, run and use impz.

- [Install](./guides/install.md) — what impz needs, a dev instance, a server bootstrap and the
  release image
- [NixOS](./guides/nixos.md) — the NixOS module, what it sets, the env file and the Tailscale key
- [Configuration](./guides/configuration.md) — every variable for impd, the host container, the dev
  instance and the CLI
- [The CLI](./guides/cli.md) — every command, sizes, exit codes and the console
- [Images](./guides/images.md) — the shipped images, what a guest takes from an image, and your own
- [Services and logs](./guides/services.md) — the processes an imp keeps running, and their logs
- [Templates](./guides/templates.md) — an image made from an imp's disk, and what each copy gets of
  its own
- [Backups](./guides/backups.md) — backups, restores, a whole-host restore and the repository's
  safety
- [More than one host](./guides/hosts.md) — placing imps, listing every host, and moving an imp
- [Credential connectors](./guides/connectors.md) — secrets and grants, and how the broker adds a
  token to a request
- [Tokens and identities](./guides/tokens.md) — scopes, imp patterns, tokens and tailnet identity
- [Leases and holds](./guides/leases.md) — who holds an imp awake, and what a RAM refusal names
- [Private networks](./guides/networks.md) — which imps reach which, and their internal names
- [Tailscale](./guides/tailscale.md) — the tailnet node, the ACL, keys, HTTPS and DNS
- [HTTPS on your own domain](./guides/https.md) — the wildcard certificate, its renewal and the DNS
  records
- [SSH](./guides/ssh.md) — `ssh box@imp`, keys, and what the gateway supports
- [Copying files](./guides/cp.md) — `impz cp` into and out of an imp
- [Reverse forwards](./guides/reverse-forwards.md) — a port in an imp that reaches one on your
  machine
- [Session logs](./guides/session-logs.md) — a session's output kept on the host, and how to read it
- [MCP server](./guides/mcp.md) — the tools a coding agent gets, and the guard on them
- [Dashboard](./guides/dashboard.md) — the web dashboard, its login, and how to build it
- [Events, audit and telemetry](./guides/events.md) — the event stream, the audit log and
  OpenTelemetry
- [CPU limits and resource use](./guides/cpu-limits.md) — CPU limits and weights, and what impd
  samples
- [Operations](./guides/operations.md) — restarts, the RAM budget, logs, checks and troubleshooting

## Runbooks

- [Development](./runbooks/development.md) — the checks, the end-to-end harness, worktree dev
  instances, git hooks, CI and the branch rules
- [Releasing](./runbooks/releasing.md) — what release-please and the release workflow do, and the
  steps they leave to you

## Reference

- [The agent protocol](./reference/agent-protocol.md) — every message impd and the guest agent
  exchange, generated from the protocol's schema
