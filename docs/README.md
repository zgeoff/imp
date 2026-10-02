# imp documentation

Architecture and guides for imp, persistent Linux microVMs that sleep when idle. The
[root README](../README.md) covers install, the CLI and everyday use.

## Architecture

- [Overview](./architecture/overview.md): the shape of the system, why Firecracker, the host
  container, the control API and the repo layout.
- [Daemon](./architecture/daemon.md): impd's modules, start and stop, and how the lifecycle, the
  governor, the proxy and the agent client fit together.
- [Guest agent and kernel](./architecture/agent.md): the two drives, the two-stage boot, the reaper,
  and why imp builds its own guest kernel.
- [Agent protocol](./architecture/protocol.md): the host ↔ guest wire format over vsock: frames,
  errors, unary requests and exec streams.
- [Storage and images](./architecture/storage.md): XFS reflinks, the data directory, checkpoints,
  restores and forks, and how an OCI image becomes an ext4 disk.
- [Backups](./architecture/backups.md): restic, what a backup holds, a run on XFS and ZFS, the
  schedule, restores, whole-host restore, and the repository's security.
- [Networking](./architecture/networking.md): addressing, iptables, the wake proxy, the credential
  broker's port and the URLs.
- [Sleep and wake](./architecture/sleep-and-wake.md): memory snapshots, idle detection, the RAM
  governor, and the prototype findings behind them.

## Guides

- [Install](./guides/install.md): what imp needs, how to run it with `scripts/dev.sh`, and how to
  get and run the release image.
- [Configuration](./guides/configuration.md): every variable for impd, the host container, the dev
  instance and the CLI.
- [Images](./guides/images.md): the shipped images, what a guest takes from an image, services,
  Docker in the guest, and how to make your own.
- [Credential connectors](./guides/connectors.md): `imp secret` and `imp grant`, the host-side
  broker that adds tokens to an imp's requests, and where secrets live.
- [Dashboard](./guides/dashboard.md): the web dashboard impd serves at `/ui/`: what it shows, the
  login, and how to build, run and test it.
- [MCP server](./guides/mcp.md): `imp mcp`, the tools a coding agent gets, the guard, and how exec
  output, timeouts and cancels work.
- [SSH](./guides/ssh.md): `ssh box@imp`, keys, what the gateway supports, and how it wakes imps.
- [Tailscale](./guides/tailscale.md): the tailnet node, the ACL, keys and state, HTTPS and DNS.
- [Tokens and identities](./guides/tokens.md): scopes, imp patterns, `imp token`, and tailnet
  identity.
- [HTTPS on your own domain](./guides/https.md): `https://<name>.<domain>` on the tailnet, the
  wildcard certificate, its renewal, the DNS records, and testing with Pebble.
- [Events, audit and telemetry](./guides/events.md): `imp events` and the event stream, the API
  audit log, and OpenTelemetry metrics and spans.
- [Operations](./guides/operations.md): restarts, the RAM budget, logs, checks and troubleshooting.
- [Development](./guides/development.md): the local checks, git hooks, CI and the branch rules on
  `main`.
- [Releasing](../RELEASING.md): what a release ships, how release-please and the release workflow
  make one, the dry run and a republish.

[STATUS.md](../STATUS.md) has the measurements and the known gaps. The
[roadmap](https://github.com/zgeoff/imp/issues/41) has what comes next.
