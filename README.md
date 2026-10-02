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

When an imp sits idle, it goes to sleep: its memory goes to disk and its RAM goes back to the host.
The next request to its URL wakes it in about a tenth of a second, with every process still running.
Checkpoint it before you let an agent loose, roll it back when the agent makes a mess, or fork it
and try two things at once.

## Install

imp runs on one Linux machine with `/dev/kvm`: bare metal, or a VM with nested virtualization. You
also need Docker, [Bun](https://bun.sh) and Go.

```sh
git clone https://github.com/zgeoff/imp && cd imp
kernel/build.sh       # the guest kernel, about 9 minutes the first time
scripts/dev.sh up     # builds and starts the host container that runs impd
scripts/dev.sh token | scripts/imp login http://localhost:7070 --name dev
```

To put imps on your tailnet, add a tagged auth key to `.env` before `up`:

```sh
TAILSCALE_AUTHKEY=tskey-auth-…
```

On a laptop that talks to an impd elsewhere, only the CLI is needed, with
`imp login https://imp.example.ts.net` to point it there. There is no release yet, so for now link
`scripts/imp` from a checkout onto your `PATH`. From the first release, `install.sh` installs the
binary, and once the Homebrew tap is set up, so does `brew install zgeoff/tap/imp`.

The [install guide](./docs/guides/install.md) has the details.

## Use

```sh
scripts/imp image build "$PWD/images/base" --name base
scripts/imp new box
scripts/imp console box
```

`imp new` returns once the imp answers, usually in about 0.6 s. From there it behaves like any
machine you own:

```sh
imp exec box -- docker run --rm hello-world
imp checkpoint box clean          # name a known-good state
imp exec box -- rm -rf /srv/app   # oops
imp restore box clean             # and back
imp fork box box-2                # a second copy to try something else in
```

| Command                                  | What it does                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `new [name]`                             | create and boot an imp (`--image`, `--cpus`, `--memory`, `--disk`)     |
| `ls`, `info`                             | list imps; show RAM use and the budget                                 |
| `exec <name> -- cmd`                     | run a command (`-t` for a terminal)                                    |
| `console <name>`                         | open a shell in a session that outlives the terminal                   |
| `sessions <name>`, `attach <name>`       | list sessions; attach to one from any machine                          |
| `checkpoint`, `checkpoints`, `restore`   | save, list and roll back disk states                                   |
| `fork <source> <name>`                   | copy an imp's disk, or a checkpoint (`--from`)                         |
| `disk resize <name> <size>`              | grow an imp's disk; the guest grows into it                            |
| `gc [--dry-run]`                         | remove storage no imp, checkpoint or image names                       |
| `sleep`, `wake`, `hold <name> <time>`    | sleep by hand; keep an imp awake for a while                           |
| `start`, `stop`, `rm`                    | boot cold, shut down, destroy                                          |
| `url <name>`                             | print the imp's local and tailnet URLs, and its own tailnet name       |
| `policy <name> [open\|box\|none]`        | show or set what the imp may reach (`--allow` for box)                 |
| `image build`, `add`, `ls`, `rm`         | manage images                                                          |
| `secret add`, `ls`, `rm`                 | store API tokens in impd, never in a guest                             |
| `grant`, `revoke`, `grants`, `audit`     | let an imp use a token through the host-side broker                    |
| `mcp --prefix <p>`                       | serve imps to a coding agent as MCP tools over stdio                   |
| `token new`, `ls`, `rm`, `key`, `whoami` | scoped API tokens and their SSH keys, limited to some imps if you like |
| `login <url>`, `host ls`, `use`, `rm`    | save impd hosts and their tokens; pick one (`--host`)                  |
| `completion bash\|zsh\|fish`             | print the shell completion script                                      |

`--memory` and `--disk` take MiB or a unit (`512m`, `2g`, `1t`); a disk is 32 GiB by default.
[Connectors](docs/guides/connectors.md) covers secrets and grants; [tokens](docs/guides/tokens.md)
covers scopes and tailnet identity. Commands that print imps, images, checkpoints or `info` take
`--json`. `scripts/imp` runs the CLI from the repo.

Other commands exit 0, 1 when impd refuses the call, or 2 for a usage error (an unknown flag, a bad
size, a relative `image build` path, an `IMP_URL` that is not an http URL, an unknown `--host`).
`imp exec` and `imp console` exit with the command's own code, or 128 + n when signal n ended it,
and set these codes themselves:

| Code | When                                                                                 |
| ---- | ------------------------------------------------------------------------------------ |
| 2    | a usage error, such as no command after `--`                                         |
| 127  | the command could not start (`EXEC_FAILED`)                                          |
| 141  | the CLI's own output closed, as in `imp exec box -- cat big \| head`                 |
| 254  | another terminal attached to the session and took it over                            |
| 255  | imp failed: impd unreachable, a rejected token, an unknown imp, a dropped connection |

`imp console box` starts the session `main`, or attaches to it if it runs (`--session <name>` names
another, `--no-session` gives a shell that ends with the terminal). Without a terminal on stdin, as
in a script, it runs without a session unless `--session` names one. Ctrl-] detaches
(`--detach-key ctrl-<key>` or `none`; Escape, Backspace, Tab, Enter and Return cannot be the key),
and closing the terminal does too: the shell keeps running in the imp, and through a sleep.
`imp sessions box` lists the sessions without waking the imp, `imp attach box [main]` shows the
session's recent output and goes on live from any machine, and `imp sessions kill box main` ends
one. One terminal is attached at a time: a new attach takes the session over. When impd restarts,
the imp sleeps, or the connection drops under an attached terminal, the CLI attaches again by itself
for up to 60 s, waiting 1 s, then 2 s, then 4 s and at most 8 s between tries. Meanwhile the detach
key still detaches and Ctrl-C gives up (130); other keys wait for the session. It does not attach
again once another terminal attached. A detach exits 0.

A signal to the CLI (Ctrl-C without `-t`, SIGTERM, SIGHUP) goes to the command, except in a session,
where it detaches; a second one ends the session with 128 + n, so the CLI stops even when the
command ignores it or impd stopped answering. A signal before the command starts ends the session at
once, also with 128 + n. With `-t`, Ctrl-C is a key the command reads.

The [dashboard](./docs/guides/dashboard.md) at `http://localhost:7070/ui/` shows the same imps,
checkpoints, images and RAM in a browser, with a console.

## SSH

With your public key bound to a token
(`imp token new laptop --scope exec --ssh-key ~/.ssh/id_ed25519.pub`) or in
`/var/lib/imp/ssh/authorized_keys`, `ssh box@imp` lands in the imp `box` over the tailnet, and wakes
it if it sleeps. `scp`, `sftp`, port forwards and editors that work over SSH, such as VS Code Remote
SSH, work too. The [SSH guide](./docs/guides/ssh.md) has the setup.

## Ports

`imp proxy box 5432 3001:3000` makes port 5432 in the imp reachable at `localhost:5432` on your
machine, and port 3000 at `localhost:3001`; a local `0` takes any free port and prints it. A
connection wakes the imp and keeps it awake while it is open, and a server that listens on the imp's
loopback only is reachable too. It needs no SSH key: it goes to impd with the CLI's token. Ctrl-C
stops it. A busy local port fails at once and names the port. impd allows 256 open connections per
imp; a forced sleep resets the open ones, and the next one wakes the imp.

## Files

`imp cp ./app box:/srv` copies a file or a directory into an imp, and `imp cp box:/var/log/x .`
copies one out, with modes, times and symlinks. A copy into the imp can reach any path and belongs
to the owner of the directory it lands in, or to `--owner`. [Copying files](./docs/guides/cp.md) has
the details.

## Sleep and wake

An imp counts as busy while it has an open shell or command, an SSH or `imp proxy` connection, a
request in flight, an open TCP connection, or real CPU work. A coding agent that waits on a model
API keeps its connection open, so it stays awake. After a quiet minute the imp sleeps.

Sleeping costs disk, not RAM. A request to the imp's URL, an `exec`, a `console`, an SSH login or an
`imp proxy` connection wakes it. Background processes, tmpfs contents and everything else in memory
come back as they were. TCP connections do not survive a sleep.

Every imp serves its port 8080 at two URLs:

- `http://<name>.imp.localhost:7080` on the host
- `http://<tailnet-host>:<port>` on your tailnet; `imp url` prints it

With a domain of your own (`IMP_DOMAIN`), it is also at `https://<name>.<domain>` on your tailnet,
with a certificate impd gets and renews ([HTTPS](./docs/guides/https.md)).

## The RAM budget

impd keeps the total RAM of awake imps under a budget, 16 GiB by default (`IMP_RAM_BUDGET_MIB`; the
[configuration guide](./docs/guides/configuration.md) lists every setting). When a new or waking imp
would go over, the least recently active imps go to sleep to make room. An imp with an open session
or a request in flight is never picked. When nothing can make room, the request fails with
`RAM_BUDGET_EXCEEDED`.

## Images

Any OCI image can be an imp: `imp image add ubuntu:24.04`, or build your own `FROM imp/base`. imp's
agent boots from a separate read-only drive, so your image needs nothing from imp. Services that
should start with the imp are small JSON files in `/etc/imp/services.d`.

`images/base` is Ubuntu with Docker. `images/dev` adds Node, Bun, Go, Python and Claude Code. The
[images guide](./docs/guides/images.md) covers the rest.

## How it works

impd, the control plane, runs in one privileged container with its own network namespace. It starts
a Firecracker process for each awake imp, gives each imp its own tap device and /30 subnet, and
keeps imp disks as copy-on-write clones on XFS. Inside each guest, a small Go agent runs as PID 1
and serves commands, terminals and freeze requests over vsock.

The [architecture overview](./docs/architecture/overview.md) has the design and the reasoning behind
each decision. [docs/](./docs/README.md) covers the daemon, the agent protocol, storage, networking,
and sleep and wake.

## Development

```sh
bun run typecheck && bun run lint && bun test
bun run lint:shell                # shellcheck over scripts/, host/, kernel/ and test/
(cd agent && go test -race ./...)
scripts/test-e2e.sh --clean       # end to end, from a clean state (--only fast for the CI subset)
```

CI runs the gates on every push and pull request; the
[development guide](./docs/guides/development.md) covers it.
