# imp — design

imp is a self-hosted take on Fly.io Sprites: persistent Linux microVMs that boot in about a second,
sleep when idle with their memory intact, wake on an HTTP request, and checkpoint, restore and fork
their disks instantly.

This file records the decisions and the reasons. `STATUS.md` records progress.

## 1. Shape

```
 CLI (bun)  ──oRPC/HTTP──┐
 browser/curl ──HTTP─────┤
                         ▼
 ┌──────────── imp host container (privileged, own netns) ────────────┐
 │  impd (bun)                                                        │
 │   ├─ rpc        oRPC router (control) + WebSocket (exec streams)   │
 │   ├─ proxy      wake-on-request HTTP/WebSocket proxy               │
 │   ├─ imps       lifecycle service, one state machine per imp       │
 │   ├─ governor   RAM budget + idle sleeper                          │
 │   ├─ vmm        Firecracker API client (HTTP over unix socket)     │
 │   ├─ agent      host side of the vsock agent protocol              │
 │   ├─ storage    XFS reflink clones, image → ext4 builder           │
 │   ├─ net        tap devices, routes, iptables                      │
 │   └─ db         Kysely + bun:sqlite                                │
 │                                                                    │
 │  firecracker ×N (detached; survive an impd restart)                │
 │  tailscaled (optional)                                             │
 └────────────────────────────────────────────────────────────────────┘
                         │ virtio-blk / virtio-net / vsock
                         ▼
 ┌──────────────── guest (one per imp) ────────────────┐
 │ /dev/vda  user rootfs (ext4, rw) from any OCI image  │
 │ /dev/vdb  imp system drive (ro): imp-agent           │
 │ PID 1 = imp-agent: mounts, network, service          │
 │   supervisor, zombie reaper, exec/PTY over vsock     │
 └──────────────────────────────────────────────────────┘
```

## 2. Decisions

### 2.1 Isolation: Firecracker microVMs

- One Firecracker microVM per imp. A hardware (KVM) boundary per tenant.
- Firecracker over QEMU: ~5 MB VMM overhead versus 50–150 MB, fast snapshot and restore, minimal
  device model. Costs: no GPU, no virtiofs.
- The jailer is not used yet. The host container is the outer boundary. Add the jailer before
  multi-tenant use.
- No inner container in the guest yet. Fly runs user code in a container inside the VM so the agent
  survives the user breaking PID 1 or `rm -rf /`. imp runs user code next to the agent. Accepted
  risk for a personal platform.

### 2.2 Host: one privileged container

- `impd`, Firecracker and tailscaled run in one container started with
  `--privileged --device /dev/kvm` and its **own** network namespace. Taps, routes and iptables
  never touch the host's network. The same image runs on bare metal.
- The host Docker socket is mounted so impd can build and export OCI images.
- Data lives in `/var/lib/imp` (see 2.4), backed by a host bind mount.

### 2.3 Guest boot: system drive + agent as PID 1

- Two drives. `vda` is the user rootfs (rw). `vdb` is the imp system drive (squashfs, ro) that holds
  `imp-agent`. User images never contain imp bits.
- Kernel cmdline: `root=/dev/vdb rootfstype=squashfs ro init=/imp-agent`, plus `imp.*` parameters
  (IP, gateway, hostname, imp id).
- Stage 1 (agent from vdb): mount vda on `/newroot`, mount proc/sys/dev, bind the system drive to
  `/newroot/run/imp/sys`, `switch_root` to `/newroot`, re-exec `/run/imp/sys/imp-agent stage2`. PID
  1 stays the agent.
- Stage 2: hostname, loopback + eth0 via netlink, `/etc/resolv.conf`, cgroup2, `/dev/pts`,
  `/dev/shm`, then start services, then listen on vsock.
- The agent owns all `wait4` calls (central reaper). Nothing else in the agent calls `cmd.Wait`;
  spawned processes register their pid and get their exit status from the reaper.

### 2.4 Storage: XFS reflinks

- `/var/lib/imp` is an XFS filesystem with reflink. On this dev box it is a sparse loop file. On
  bare metal it can be a real XFS partition.
- WSL 6.6 needs `mkfs.xfs -m reflink=1 -i nrext64=0,exchange=0 -n parent=0`. Newer xfsprogs defaults
  do not mount on that kernel.
- An image becomes `images/<digest>/rootfs.ext4` once (a sparse ext4 file, default 32 GiB). An imp
  disk is a reflink clone of it: instant, no copy.
- A checkpoint is a reflink clone of the imp disk, taken after the agent runs `sync` and `FIFREEZE`
  on `/`. A restore stops the VM, clones the checkpoint back over the disk, and boots. A fork clones
  a disk or a checkpoint into a new imp.
- Fork is disk only. A memory fork duplicates entropy and IDs across clones.

```
/var/lib/imp/
  db/imp.sqlite
  system/vmlinux  system/imp-system.squashfs
  images/<digest>/rootfs.ext4  images/<digest>/config.json
  imps/<id>/disk.ext4
  imps/<id>/run/{api.sock,vsock.sock,firecracker.log,pid}
  imps/<id>/snapshot/{vmstate,mem,meta.json}
  imps/<id>/checkpoints/<cid>/disk.ext4
```

### 2.5 Images: any OCI image

- `imp image build <dir>` runs `docker build`. `imp image add <ref>` takes an existing image. impd
  runs `docker create` + `docker export`, unpacks the tar, and writes it with `mkfs.ext4 -d`. The
  cache key is the image ID.
- The OCI config (Env, WorkingDir, User) goes to `/etc/imp/image.json` in the rootfs. The agent uses
  it as the default environment for exec.
- Services an image wants on boot go in `/etc/imp/services.d/<name>.json`. `images/base` ships
  `dockerd` this way. A user adds a service by writing a file there with `imp exec`; it persists
  with the disk. An API to manage services is future work.
- `images/base`: Ubuntu 24.04 minimal, Docker engine, ca-certificates. `images/dev`: FROM base plus
  Node, Bun, Go, Python and Claude Code.

### 2.5a Guest kernel

- A custom 6.1 LTS kernel (`kernel/`), built from Firecracker's CI config plus
  `kernel/docker.fragment`. Everything is builtin; there are no modules.
- Why: the CI kernel lacks nftables and the iptables raw table, and Docker 28+ writes to the raw
  table. AppArmor stays off, so images need no `apparmor_parser`.

### 2.6 Network

- Routed, not bridged. Each imp gets a tap `imp<slot>` and a /30: host side `10.66.x.(4n+1)`, guest
  `4n+2`. No shared L2, so imps cannot see each other.
- iptables: MASQUERADE out of the container; `FORWARD -i imp+ -o imp+ DROP`; `INPUT -i imp+` drops
  everything except established traffic.
- Guest DNS: public resolvers (configurable).
- The slot is stable for the imp's life, so the tap name and IP survive a sleep and a restore.

### 2.7 Host ↔ guest: agent protocol over vsock

- Firecracker exposes guest vsock as a unix socket. The host connects, sends `CONNECT 1024\n`, reads
  `OK <port>\n`, then speaks the imp protocol.
- One request per connection. The first frame is a JSON request. Exec connections then carry binary
  frames: `[u8 type][u32 BE length][payload]`. Types: stdin, stdout, stderr, resize, signal, exit,
  eof.
- Requests: `ping`, `exec`, `freeze`/`thaw`, `activity`, `resumed` (sets the clock after a wake),
  `services.*`, `shutdown`.
- The spec lives in `agent/PROTOCOL.md`. Go and TypeScript implement it.

### 2.8 Sleep and wake

Measured procedure and numbers: `docs/sleep-findings.md`.

- Every VM gets a balloon before InstanceStart:
  `{"amount_mib":0,"deflate_on_oom":true,"stats_polling_interval_s":1,"free_page_reporting":true}`.
  With free page reporting, memory the guest frees goes back to the host in about 15 s.
- Sleep: pause, full snapshot to `vmstate.new` / `memory.new`, `fallocate --dig-holes` on the memory
  file (a 2 GiB file with 300 MiB touched becomes 381 MiB), rename over the old files, stop
  Firecracker. Never overwrite a memory file in place: a restored VM maps it MAP_PRIVATE.
- Wake: remove the stale `vsock.sock`, start Firecracker, make `PUT /snapshot/load`
  (`resume_vm: true`) the first API call, ping the agent, send `resumed` with the host time (the
  guest clock is otherwise behind by the sleep time). Wake takes about 50–100 ms; pages then fault
  in lazily from the memory file.
- On any load failure or a snapshot version mismatch, boot cold instead.
- `meta.json` stores the Firecracker version, the snapshot format, the host kernel, hashes of the
  guest kernel and the system drive, and the RAM the VM owned at sleep. Any difference means a cold
  boot. Snapshot files stay until the next sleep renames over them, a stop, or a cold boot.
- Snapshot writes run 2 at a time (one host-wide semaphore).
- Anything that needs a VM wakes a sleeping imp and cold-boots a stopped one: exec, console, the
  proxy, `start`, `wake` and `hold`. `stop` frees the memory; it does not keep the imp off.
- TCP connections across a sleep reset. In-memory processes survive. An exec stream whose host side
  hangs up gets SIGHUP and is detached after 1 s, so it does not keep the imp awake.
- On SIGTERM or SIGINT impd sleeps every awake imp, so a container restart keeps memory
  (`scripts/dev.sh down` gives it 120 s). After a crash, an imp with no live VM is marked `stopped`
  and boots cold; sleeping imps stay asleep and wake on demand.
- Firecracker processes are detached (`setsid`). On SIGHUP impd exits without sleeping anything; the
  next impd re-adopts every live VM by pid and API socket, even one whose agent answers late
  (`scripts/dev.sh restart`).

### 2.9 Idle detection and the RAM governor

- Every 2 s, an imp is active when it has an open exec session or proxied connection (counted on the
  host), established guest TCP connections (the agent's `activity`), Firecracker CPU above
  `IMP_IDLE_CPU_PERCENT` of one core (default 10; an idle guest uses about 0.4), or a hold. A
  headless agent waiting on an LLM API keeps a TCP connection open, so it stays awake.
- The proxy's own connections reach the guest as TCP from the gateway. The proxy sends
  `Connection: close` upstream, so a finished request leaves no keep-alive socket that counts.
- Idle for `IMP_IDLE_TIMEOUT_S` (default 60 s) → sleep.
- Holds: `imp hold <name> <duration>` keeps an imp awake (and wakes it); `0` releases.
- RAM budget `IMP_RAM_BUDGET_MIB` (default 16384). Usage = sum of Firecracker `Pss_Anon` +
  `Pss_Shmem` (`smaps_rollup`): pages a woken guest only read are clean pages of the mem file, which
  the host can drop. `system.info` also reports the committed memory of awake imps.
- Before a boot or wake, impd reserves RAM under one global lock: a cold boot
  `IMP_BOOT_RESERVE_PERCENT` (default 50) of the imp's memory, a wake the larger of what it owned at
  sleep and `IMP_WAKE_RESERVE_MIB` (default 256). A reservation counts until the measurement passes
  it, at most 20 s. If the sum would pass the budget, impd sleeps the least recently active imps
  (not held, not busy) until it fits. If it still cannot fit, the request fails with
  `RAM_BUDGET_EXCEEDED`. Every 5 s, impd sleeps LRU imps while measured usage is over the budget.

### 2.10 Control plane and API

- Bun workspaces: `packages/api` (oRPC contract + zod schemas), `packages/daemon` (impd),
  `packages/cli` (imp).
- Control calls are oRPC procedures over HTTP (`/rpc`). Exec and console are a WebSocket at `/exec`,
  because they need two-way streams.
- Auth: a bearer token made on first start, stored in `/var/lib/imp/token`. The proxy is open to
  anything that can reach it; the tailnet ACL is the boundary.
- Kysely on `bun:sqlite`, migrations in code.

### 2.11 URLs and Tailscale

- Local: `http://<name>.imp.localhost:7080` (Host header routing; any `<name>.<domain>` works).
- The proxy forwards to the imp's `httpPort` (default 8080, set at create). WebSockets are relayed
  message by message. A wake adds an `x-imp-wake-ms` response header.
- Tailnet: hostnames on MagicDNS do not support wildcards, so each imp also gets a stable port:
  `http://imp:<20000+slot>`.
- tailscaled runs in the host container with `TAILSCALE_AUTHKEY`, `--advertise-tags=tag:imp`,
  hostname `imp`.

## 3. Repo layout

```
agent/            Go guest agent (PID 1, vsock server)
packages/api      oRPC contract and shared types
packages/daemon   impd
packages/cli      imp CLI
images/base       thin base image
images/dev        example dev image
host/             host container Dockerfile, entrypoint, xfs setup
kernel/           guest kernel config and build (when the CI kernel is not enough)
scripts/          acceptance.sh and dev helpers
```

## 4. Not yet

- Jailer, inner container, diff snapshots, memory forks, multi-host, S3-backed storage, credential
  connectors.
