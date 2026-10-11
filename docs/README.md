# imp documentation

Architecture and guides for imp, persistent Linux microVMs that sleep when idle. The
[root README](../README.md) covers install, the CLI and everyday use.

## Architecture

[The overview](./architecture/overview.md) gives the whole system on one page: the path of a
request, the topology, the data and the rules that cross every part.

- **Lifecycle.** [The lifecycle](./architecture/lifecycle/lifecycle.md): states, the per-imp lock,
  leases, the watchdog and recovery after a restart.
  [Sleep and wake](./architecture/lifecycle/sleep-and-wake.md): snapshots, the wake, snapshot
  identity and idle detection. [The RAM governor](./architecture/lifecycle/ram-governor.md): the
  budget, admission, enforcement and KSM.
  [Elastic memory](./architecture/lifecycle/elastic-memory.md) and
  [boot templates](./architecture/lifecycle/boot-templates.md).
- **The guest.** [The agent](./architecture/guest/agent.md): the drives, the boot, the inner
  container and the kernel. [The agent protocol](./architecture/guest/protocol.md) and
  [sessions](./architecture/guest/sessions.md), with output offsets and session logs.
- **Storage.** [Storage](./architecture/storage/storage.md): the backends, checkpoints, restores and
  forks. [Disk space](./architecture/storage/disk-space.md): sizes, the budget, usage and the sweep.
  [Images](./architecture/storage/images.md), [backups](./architecture/storage/backups.md) and
  [moves](./architecture/storage/moves.md).
- **Network.** [Networking](./architecture/network/networking.md): addressing, the base firewall and
  IPv6. [Egress](./architecture/network/egress.md): the policies, the resolver and private networks.
  [Ingress](./architecture/network/ingress.md): the wake proxy, HTTPS, SSH and tunnels.
  [The credential broker](./architecture/network/broker.md).
- **Control.** [The API](./architecture/control/api.md): the contract, the streams, the clients,
  events, audit and telemetry. [Auth](./architecture/control/auth.md): callers, scopes, the
  dashboard session, tailnet identity and OAuth.
- [Isolation](./architecture/isolation.md): the VM, the jailer, cgroups and the host container.
  [The host](./architecture/host.md): what the host gives, the privileges and the Docker socket.

## Guides

- [Install](./guides/install.md): what imp needs, how to run it with `scripts/dev.sh`, and how to
  get and run the release image.
- [NixOS](./guides/nixos.md): `nixosModules.imp`, what it sets, the env file, the Tailscale key and
  the VM test.
- [Configuration](./guides/configuration.md): every variable for impd, the host container, the dev
  instance and the CLI.
- [Images](./guides/images.md): the shipped images, what a guest takes from an image, services,
  Docker in the guest, and how to make your own.
- [Services and logs](./guides/services.md): `imp service` to add, restart and remove the processes
  an imp keeps running, and `imp logs` to print and follow their logs.
- [Backups](./guides/backups.md): `imp backup`, restores, a whole-host restore, and protecting the
  repository.
- [Templates](./guides/templates.md): `imp template`, an image made from an imp's disk, how a copy
  gets its own machine-id and ssh host keys, and how templates are stored and backed up.
- [Credential connectors](./guides/connectors.md): `imp secret` and `imp grant`, the host-side
  broker that adds tokens to an imp's requests, and where secrets live.
- [Dashboard](./guides/dashboard.md): the web dashboard impd serves at `/ui/`: what it shows, the
  login, and how to build, run and test it.
- [MCP server](./guides/mcp.md): `imp mcp` and impd's `/mcp` endpoint, the tools a coding agent
  gets, the guard, and how exec output, timeouts and cancels work.
- [Private networks](./guides/networks.md): `imp net`, which imps reach which, and the
  `<imp>.<network>.internal` names.
- [SSH](./guides/ssh.md): `ssh box@imp`, keys, what the gateway supports, and how it wakes imps.
- [Reverse forwards](./guides/reverse-forwards.md): `imp proxy --reverse`, a socket or a port in an
  imp that reaches one on your machine, and how it lives through sleeps.
- [Session logs](./guides/session-logs.md): `imp console --log`, a session's output kept on the host
  past the agent's ring, how it is read, bounded and deleted, and what survives which event.
- [Copying files](./guides/cp.md): `imp cp` into and out of an imp, what a copy keeps, how it works,
  and its safety rules.
- [Tailscale](./guides/tailscale.md): the tailnet node, the ACL, keys and state, HTTPS and DNS.
- [More than one host](./guides/hosts.md): `imp new --place` on the saved host with the most free
  RAM, `imp ls --all` over every saved host, and `imp move`: what a move keeps, the URLs, tickets,
  failures and limits.
- [Tokens and identities](./guides/tokens.md): scopes, imp patterns, `imp token`, and tailnet
  identity.
- [HTTPS on your own domain](./guides/https.md): `https://<name>.<domain>` on the tailnet, the
  wildcard certificate, its renewal, the DNS records, and testing with Pebble.
- [Leases and holds](./guides/leases.md): `leases.*` and `imp hold`, who owns a lease, what blocks a
  sleep or a stop, and what a RAM refusal names.
- [Events, audit and telemetry](./guides/events.md): `imp events` and the event stream, the API
  audit log, and OpenTelemetry metrics and spans.
- [CPU limits and resource use](./guides/cpu-limits.md): `imp set`, `imp top`, CPU limits and
  weights, and what impd samples from each running imp.
- [Operations](./guides/operations.md): restarts, the RAM budget, logs, checks and troubleshooting.
- [Development](./guides/development.md): the local checks, git hooks, CI and the branch rules on
  `main`.
- [Releasing](../RELEASING.md): what a release ships, how release-please and the release workflow
  make one, the dry run and a republish.

[STATUS.md](../STATUS.md) has the measurements and the known gaps. The
[roadmap](https://github.com/zgeoff/imp/issues/41) has what comes next.
