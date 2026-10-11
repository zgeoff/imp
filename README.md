<div align="center">
  <h1>imp</h1>

  <p>
    <a href="./docs/README.md">Documentation</a> •
    <a href="./docs/guides/configuration.md">Configuration</a> •
    <a href="./docs/architecture/overview.md">Architecture</a>
  </p>
</div>

**imp** gives you small Linux computers that stay yours. Each one is a Firecracker microVM with real
root, its own kernel and Docker inside. It boots in under a second, and its disk keeps everything
you put there.

Imps are heavily inspired by Fly.io's wonderful [Sprites](https://fly.io/sprites/). If you want
something more polished or out-of-the-box, check them out.

## Why imps?

When an imp sits idle, it goes to sleep: its memory goes to disk and its RAM goes back to the host.
The next request to its URL wakes it in about a tenth of a second, with every process still running.
Checkpoint it before you let an agent loose, roll it back when the agent makes a mess, or fork it
and try two things at once.

## Install

imp runs on one Linux machine with `/dev/kvm`: bare metal, or a VM with nested virtualization, with
Docker. On a fresh Ubuntu or Debian server, `deploy/bootstrap.sh` from a release tag sets up the
host and starts impd ([bootstrap a server](./docs/guides/install.md#bootstrap-a-server)), and
[NixOS](./docs/guides/nixos.md) has a module. Then install the CLI on your own machine:

```sh
curl -fsSL https://raw.githubusercontent.com/zgeoff/imp/main/install.sh | sh   # install the CLI
imp login https://imp.example.ts.net  # point it at your impd and its token
imp new box                           # create and boot an imp
imp console box                       # a shell that outlives the terminal
imp checkpoint box clean              # name a known-good state
imp restore box clean                 # and back
```

The [install guide](./docs/guides/install.md) also covers a dev instance from the repo and the
release image.

## Features

- **Sleep and wake** with every process intact, and an idle imp holds no RAM
  ([sleep and wake](./docs/architecture/lifecycle/sleep-and-wake.md)).
- **A RAM budget** that sleeps the least recently active imps to make room
  ([the RAM governor](./docs/architecture/lifecycle/ram-governor.md)).
- **Checkpoints, restores and forks** as copy-on-write clones on XFS or ZFS
  ([storage](./docs/architecture/storage/storage.md)).
- **Any OCI image**, built in a throwaway imp by default ([images](./docs/guides/images.md)).
- **Sessions** that survive a closed terminal and a sleep
  ([session logs](./docs/guides/session-logs.md)).
- **SSH, port forwards and copies** into any imp ([SSH](./docs/guides/ssh.md),
  [copying files](./docs/guides/cp.md), [reverse forwards](./docs/guides/reverse-forwards.md)).
- **Egress policies and private networks** for what an imp may reach
  ([networks](./docs/guides/networks.md), [egress](./docs/architecture/network/egress.md)).
- **Credential connectors** that keep API tokens on the host, never in the guest
  ([connectors](./docs/guides/connectors.md)).
- **URLs on the tailnet**, HTTPS on your own domain, and public imps
  ([Tailscale](./docs/guides/tailscale.md), [HTTPS](./docs/guides/https.md)).
- **Scoped tokens and tailnet identity** ([tokens](./docs/guides/tokens.md)).
- **An MCP server** for coding agents ([MCP](./docs/guides/mcp.md)), a typed client on npm, and a
  [dashboard](./docs/guides/dashboard.md).
- **Backups** off the host with restic ([backups](./docs/guides/backups.md)), and **moves** between
  hosts ([more than one host](./docs/guides/hosts.md)).

## Configuration

impd reads its settings from the environment: the RAM budget, the storage backend, the ports, the
domain, backups and the rest. The [configuration guide](./docs/guides/configuration.md) lists every
variable for impd, the host container, the dev instance and the CLI.

## Documentation

[docs/](./docs/README.md) covers the architecture, the guides and development.
