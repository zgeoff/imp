<div align="center">
  <h1>imp</h1>

  <p>
    <a href="./DESIGN.md">Design</a> •
    <a href="./images/README.md">Images</a> •
    <a href="./agent/PROTOCOL.md">Agent protocol</a> •
    <a href="./STATUS.md">Status</a>
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
export IMP_TOKEN=$(scripts/dev.sh token)
```

To put imps on your tailnet, add a tagged auth key to `.env` before `up`:

```sh
TAILSCALE_AUTHKEY=tskey-auth-…
```

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

| Command                                | What it does                                             |
| -------------------------------------- | -------------------------------------------------------- |
| `new [name]`                           | create and boot an imp (`--image`, `--cpus`, `--memory`) |
| `ls`, `info`                           | list imps; show RAM use and the budget                   |
| `exec <name> -- cmd`                   | run a command (`-t` for a terminal)                      |
| `console <name>`                       | open a shell                                             |
| `checkpoint`, `checkpoints`, `restore` | save, list and roll back disk states                     |
| `fork <source> <name>`                 | copy an imp's disk, or a checkpoint (`--from`)           |
| `sleep`, `wake`, `hold <name> <time>`  | sleep by hand; keep an imp awake for a while             |
| `start`, `stop`, `rm`                  | boot cold, shut down, destroy                            |
| `url <name>`                           | print the imp's local and tailnet URLs                   |
| `image build`, `add`, `ls`, `rm`       | manage images                                            |

`ls` and `info` take `--json`. `scripts/imp` runs the CLI from the repo.

## Sleep and wake

An imp counts as busy while it has an open shell or command, a request in flight, an open TCP
connection, or real CPU work. A coding agent that waits on a model API keeps its connection open, so
it stays awake. After a quiet minute the imp sleeps.

Sleeping costs disk, not RAM. A request to the imp's URL, an `exec`, or a `console` wakes it.
Background processes, tmpfs contents and everything else in memory come back as they were. TCP
connections do not survive a sleep.

Every imp serves its port 8080 at two URLs:

- `http://<name>.imp.localhost:7080` on the host
- `http://<tailnet-host>:<port>` on your tailnet; `imp url` prints it

## The RAM budget

impd keeps the total RAM of awake imps under a budget, 16 GiB by default (`IMP_RAM_BUDGET_MIB`).
When a new or waking imp would go over, the least recently active imps go to sleep to make room. An
imp with an open session or a request in flight is never picked. When nothing can make room, the
request fails with `RAM_BUDGET_EXCEEDED`.

## Images

Any OCI image can be an imp: `imp image add ubuntu:24.04`, or build your own `FROM imp/base`. imp's
agent boots from a separate read-only drive, so your image needs nothing from imp. Services that
should start with the imp are small JSON files in `/etc/imp/services.d`.

`images/base` is Ubuntu with Docker. `images/dev` adds Node, Bun, Go, Python and Claude Code. The
[images guide](./images/README.md) covers the rest.

## How it works

impd, the control plane, runs in one privileged container with its own network namespace. It starts
a Firecracker process for each awake imp, gives each imp its own tap device and /30 subnet, and
keeps imp disks as copy-on-write clones on XFS. Inside each guest, a small Go agent runs as PID 1
and serves commands, terminals and freeze requests over vsock.

[DESIGN.md](./DESIGN.md) has the architecture and the reasoning behind each decision.

## Development

```sh
bun run typecheck && bun run lint && bun test
(cd agent && go test -race ./...)
scripts/acceptance.sh --clean     # end to end, from a clean state
```
