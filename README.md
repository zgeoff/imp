# imp

Persistent Linux microVMs that boot in under a second, sleep when idle with their memory intact, and
wake on an HTTP request. A self-hosted take on Fly.io Sprites.

- **Firecracker microVMs**: one KVM boundary per imp, real root, Docker inside.
- **Any OCI image**: build `FROM imp/base` or bring your own. imp's agent comes in on a separate
  read-only drive and never touches your image.
- **Sleep and wake**: idle imps snapshot to disk and give their RAM back. A request to the imp's URL
  wakes it in about 100 ms, with processes still running.
- **Checkpoints and forks**: instant copy-on-write disk clones on XFS.
- **RAM budget**: when the host runs short, the least recently used imps go to sleep.
- **Tailscale**: the host joins your tailnet; every imp gets a URL there.

## Quick start

Requirements: Linux with `/dev/kvm`, Docker, Bun and Go.

```sh
kernel/build.sh                      # guest kernel with Docker support (~9 min the first time)
scripts/dev.sh up                    # build and start the host container with impd
export IMP_TOKEN=$(scripts/dev.sh token)

scripts/imp image build "$PWD/images/base" --name base
scripts/imp new box                  # ~0.6 s to a usable shell
scripts/imp console box
```

Put `TAILSCALE_AUTHKEY=` in `.env` (a tagged auth key) to join the tailnet.

## Commands

| Command                                                    | What it does                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------- | --- | --- | ------------- |
| `imp new [name] [--image] [--cpus] [--memory]`             | Create an imp and boot it                                   |
| `imp ls`, `imp info`                                       | List imps; show the RAM budget and usage (`--json` on both) |
| `imp exec [-t] <name> -- cmd…`                             | Run a command; `imp console <name>` for a shell             |
| `imp sleep`, `imp wake`, `imp hold <name> <duration>`      | Control sleep by hand; a hold keeps an imp awake            |
| `imp checkpoint <name> [label]`, `imp restore`, `imp fork` | Disk checkpoints, rollback and clones                       |
| `imp url <name>`                                           | Local and tailnet URLs (the guest serves on :8080)          |
| `imp image build                                           | add                                                         | ls  | rm` | Manage images |

## How it works

`DESIGN.md` has the architecture and the reasons behind each decision. `STATUS.md` has the
milestones and measured numbers. Other docs:

- `agent/PROTOCOL.md`: the host ↔ guest protocol over vsock
- `images/README.md`: how images work and how to make your own
- `docs/sleep-findings.md`: the measured sleep and wake procedure
- `docs/tailscale.md`: tailnet setup and URL scheme
- `kernel/README.md`: why imp builds its own guest kernel

## Tests

```sh
bun run typecheck && bun run lint && bun test     # TypeScript
(cd agent && go test -race ./...)                 # guest agent
scripts/acceptance.sh --clean                     # end to end, from a clean state
```
