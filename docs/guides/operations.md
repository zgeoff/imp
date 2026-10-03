# Operations

Day-to-day care of an imp host: restarts, the RAM budget, logs, and checks. The commands assume the
dev instance from the [install guide](./install.md). On a server running the release image,
`systemctl restart imp-host` (or `docker compose restart`) does what `reboot` does here, and
`docker exec imp-host pkill -HUP -x impd` what `restart` does.

## Restart without losing imps

| Command                  | What happens to the imps                                                          |
| ------------------------ | --------------------------------------------------------------------------------- |
| `scripts/dev.sh restart` | impd gets SIGHUP and exits; the VMs keep running and the new impd re-adopts them. |
| `scripts/dev.sh down`    | impd sleeps every awake imp (up to 120 s), then the container goes away.          |
| `scripts/dev.sh reboot`  | `down`, then `up`. Imps come back asleep and wake on demand.                      |

`up` and `restart` also compile the Docker socket proxy from the repo with the image's own `bun`,
and replace the running proxy when its binary, privileges, env or image changed. `up` leaves a
changed proxy running while impd runs, so a build in flight is not cut off; `restart` replaces it
before impd comes back. The proxy's token survives the replacement, so the containers it made stay
its own.

Use `restart` after a change to impd's code: the entrypoint restarts impd, and nothing in the guests
notices. Use `reboot` after a change to `host/`. Data stays in `.data/dev` across all three.

After a crash (impd or the container killed without a signal), an imp with no live VM comes back
`stopped` and boots cold on the next use. Its disk is intact; its memory is lost. Sleeping imps stay
asleep. A VM that the dead impd left behind is adopted or killed, so no imp ends with two.
[Sleep and wake](../architecture/sleep-and-wake.md#restarts) has the details.

## Upgrade

`deploy/upgrade.sh` moves a server to a new release image. Pass `--compose deploy/compose.yaml` when
the host runs under compose; the default is the systemd unit. It needs `docker`, `curl` and `jq`.

```sh
deploy/upgrade.sh
```

Take `upgrade.sh` from the new image, not from the release the host runs. A host on the release
before the Docker socket proxy must: its own `upgrade.sh` refuses the new image, whose
`imp.host-contract` label is `socket-proxy`. Each release's `upgrade.sh` moves the host to that
release, so pick the release in the image you take it from:

<!-- x-release-please-start-version -->

```sh
docker pull ghcr.io/zgeoff/imp-host:0.26.0
docker run --rm ghcr.io/zgeoff/imp-host:0.26.0 cat /usr/local/share/imp/deploy/upgrade.sh >upgrade.sh
bash upgrade.sh
```

<!-- x-release-please-end -->

1. It pulls the image of its own release, unless `IMP_HOST_IMAGE` names another: from the
   environment, else a pin in `/etc/imp/imp-host.env`. It stops there when the host already runs
   that image. With the systemd unit, it refuses an image from the environment that the new units
   would not run: pin it in the env file instead. It refuses an env file whose last
   `IMP_HOST_IMAGE=` is empty, which would give the units no image. It refuses an image from before
   the Docker socket proxy once the unit or compose file gives imp-host the proxy's socket, and an
   image from before the unprivileged host (no `imp.host-contract` label) once it runs without
   `--privileged`. To go back past either, run `deploy/bootstrap.sh` of that image's release.
2. It sleeps every awake imp through the API, one at a time. If the list or one sleep fails, it
   stops and the host keeps the old image. The stop would sleep them too, but only within its 120 s.
3. It installs the new image's seccomp profile in `/etc/imp/imp-host.seccomp.json` and, for the
   systemd unit, its `imp-host.service` and `imp-docker-proxy.service`, so a change to the
   [privileges](../architecture/host-contract.md#privileges) or the
   [Docker socket](../architecture/host-contract.md#the-docker-socket) reaches the server. Keep
   local changes to a unit in a drop-in (`imp-host.service.d/`). A compose file is the operator's:
   upgrade.sh leaves it, and says when it still runs `--privileged` or still gives imp-host the
   host's `docker.sock`. Then take the `imp-docker-proxy` service and imp-host's volumes from this
   release's `deploy/compose.yaml`. The proxy closes the Docker socket path only: `SYS_ADMIN` still
   lets root out of the container.

   An env file line `IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest`, which every env file had before
   the units named their release, is the old template's and no pin. It becomes the commented pin, so
   the units run their release's image; the file before stays as `imp-host.env.bak`. Any other value
   is a pin and stays. To follow `latest` on purpose, pin `IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host`,
   which Docker reads as `latest`.

   With compose, it writes `IMP_HOST_IMAGE` to the `.env` next to the compose file, and keeps the
   file before as `.env.bak`. Compose reads that `.env` at each `up`, so a later
   `docker compose up -d` keeps the new image, not the default of an older compose file.

4. It enables and restarts `imp-docker-proxy`, then restarts the host (with compose, `up -d` of both
   services, or of imp-host alone when the file has no proxy). It waits for `/health` to report
   ready, prints how to roll back (`docker tag` the old image ID, then
   `systemctl restart imp-docker-proxy imp-host`), prints the boot status counts from `imp info`,
   and lists the imps.

Imps then wake on demand. Each sleeping imp either restores its memory or boots its disk cold. The
disk is never touched. [Snapshot identity](../architecture/sleep-and-wake.md#snapshot-identity) has
the full rule:

- A new impd alone, or a new agent drive: memory restores. impd keeps the old drive while a snapshot
  needs it, and the woken imp runs its old agent until its next cold boot.
- A new guest kernel: memory restores, and the imp runs its old kernel until its next cold boot.
- A new Firecracker or host kernel: every sleeping imp boots cold.

An outdated kernel or agent alone never causes a cold boot: the snapshot still loads. The imp picks
up the new part only at its next stop and start; a sleep and a wake does not clear it.

`imp info` counts both kinds on its `boot status` line, over running and sleeping imps, for example
`3 will boot cold; outdated: 2 agent`. A sleeping imp counts as a cold boot when its snapshot cannot
load or is gone. A running imp counts when it runs an older Firecracker or an older impd booted it:
its next sleep writes a snapshot the host cannot load. `imp info --json` has the same numbers under
`bootStatus`.

`imp ls` says what an upgrade means for each imp in its NOTE column:

| NOTE                                                | Meaning                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `boots cold: <reason>`                              | A sleeping imp whose snapshot cannot load; its next wake boots the disk.                        |
| `booted cold: <reason>`                             | An awake imp whose last wake became a cold boot, and why. Its next sleep clears it.             |
| `outdated: agent`                                   | The imp runs an older agent, kernel or Firecracker than the host has now.                       |
| `booted by an older impd; its next wake boots cold` | An awake imp whose VM an impd from before this scheme booted. Its snapshot cannot name a drive. |

To pick up the new agent or kernel in an outdated imp, run `imp stop <name>` and `imp start <name>`.
It loses its memory, not its disk. impd deletes the old drive on its next start, once no imp uses
it.

An imp still on an agent from before protocol `0.8.0` (release v0.7.0 or older) cannot kill the rest
of a stopped command's process group. When `imp mcp` stops such a command on a timeout or a cancel,
a child that ignores SIGTERM (a `nohup` job, say) keeps running until the imp restarts. An agent
from before `0.11.0` kills only the process group, so a child that left it with `setsid` lives on
([MCP](./mcp.md)).

An impd from before this scheme kept the drive at `/var/lib/imp/system/imp-system.squashfs`, and a
VM it booted still runs from that file. impd leaves the file alone. Remove it once no such VM runs:
`imp ls` shows none with `booted by an older impd`.

**Roll back** with `docker tag <old image ID> <image>` and the same restart. A rollback to an impd
from before this upgrade scheme (the first release with `system/drives/`) does not match the hashes
in the new snapshot records, and every sleeping imp boots cold once. The same happens once the other
way: an older impd hashed the drive with another hash and wrote no drive path, so its snapshots boot
cold with `the snapshot is from an older impd`.

**CAUTION:** A rollback to an image from before the unprivileged host needs the old unit with
`--privileged`, which `docker tag` does not bring back; upgrade.sh refuses it. Run
`deploy/bootstrap.sh` of that release with the old image instead: it writes the unit that image
needs. Under compose, put `privileged: true` back in the compose file.

**CAUTION:** `deploy/bootstrap.sh` blanks the spent Tailscale key once the node has joined, and the
image starts `tailscaled` from its saved state. An image without the `imp.tailscale-keyless` label
skips `tailscaled` with a blank key, so a rollback to one takes the node off the tailnet at its next
start. Put a new key in `/etc/imp/imp-host.env` first
([the Tailscale key](./install.md#the-tailscale-key)).

## The RAM budget

impd keeps the RAM of awake imps under `IMP_RAM_BUDGET_MIB`. `imp info` shows the budget, the
measured use, the committed memory of awake imps, and the imp counts.

- When a boot or a wake would go over, impd sleeps the least recently active imps first.
- An imp with an open session, a request in flight or a hold is never picked.
- When nothing can make room, the request fails with `RAM_BUDGET_EXCEEDED`. Free room with
  `imp sleep` or `imp stop`, or raise the budget.

To keep an imp awake on purpose, hold it: `imp hold box 2h`. `imp hold box 0` releases it.

## Disk space and silent agents

A sleep writes the imp's memory to disk. impd refuses the sleep with `DISK_FULL` when the write
would cut into `IMP_DISK_RESERVE_GIB`; the imp stays awake. Admission fails with `DISK_FULL` too
when the disk kept impd from sleeping an imp to make RAM room. Free disk on the data volume to clear
it.

An agent that stops answering for `IMP_WATCHDOG_TIMEOUT_S` shows `agent silent since …` in `imp ls`
and the dashboard, and impd logs it. Set `IMP_WATCHDOG_ACTION=restart` to boot such an imp cold, or
`snapshot` to keep its memory in `<imp>/watchdog/` first. Backups skip that folder.

## Backups

With `IMP_BACKUP_REPOSITORY` set, impd backs up every imp to a restic repository on a schedule
([backups](../architecture/backups.md), [settings](./configuration.md#backups)).

- `imp backup ls` shows the restore points and the last prune and check.
- `impd: backup: CHECK FAILED` in the log, or `FAILED` in `imp backup ls`, means the repository may
  be damaged: run `imp backup check --subset 100%`, then repair it with `restic repair`
  ([restic docs](https://restic.readthedocs.io/en/stable/077_troubleshooting.html)) from a machine
  with the password.
- `imp backup restore <name> --as <new>` restores next to the original; restored imps are stopped.

## Storage cleanup

impd removes what a crash leaves at start and every hour
([cleanup](../architecture/storage.md#cleanup)). `imp gc` runs the same sweep now.

- `imp gc --dry-run` lists what would go, and removes nothing.
- A disk, image, checkpoint or memory snapshot that no row names is an orphan. impd keeps it, with
  its snapshots, and logs `impd: storage: kept orphan …` at start and `impd: gc: kept orphan …` on
  the hourly pass when the set changed: its dataset, snapshot or directory, size, creation time and
  snapshots. `imp gc` lists them under `kept`.
- Orphans come from a create or a checkpoint that crashed before its row, or from a lost or replaced
  database. After a database restore, check the list before you remove anything: each orphan may be
  an imp.
- `imp gc --orphans --dry-run` lists what `imp gc --orphans` would retire.

**CAUTION:** `imp gc --orphans` deletes every disk, image, checkpoint and memory snapshot the
database does not name. It cannot be undone. Run it with `--dry-run` first, and only when no orphan
holds data you need.

The API is `system.gc` with `{ dryRun?, orphans? }`. It returns `dryRun`, `dropped` (each `kind` and
`id`) and `kept` (each orphan's `kind`, `id`, `location`, `bytes`, `createdAt` and `snapshots`).

## Logs

- `scripts/dev.sh logs` follows impd. Every boot, sleep and wake logs a line with its time and a
  breakdown per step.
- `docker logs imp-docker-proxy` (`<name>-docker-proxy` for a dev instance) shows each Docker call
  the proxy refused, with the rule
  ([the Docker socket](../architecture/host-contract.md#the-docker-socket)).
- Each imp's serial console and Firecracker log go to `/var/lib/imp/imps/<id>/run/firecracker.log`
  in the container (`scripts/dev.sh shell`).
- A service's output goes to `/var/log/imp/<name>.log` inside the imp. `imp logs <imp> <service>`
  prints it, and `-f` follows it ([services](./services.md)).

## Checks

`scripts/test-e2e.sh --clean` drives a real instance through every feature, one suite each: the
[development guide](./development.md#end-to-end-tests) lists them, from the lifecycle and the scale
test to the chaos suite and the backup restore drill. [STATUS.md](../../STATUS.md) has the latest
results. The development guide lists the other checks.

## A broken container

User code runs in a container inside the guest
([agent](../architecture/agent.md#the-inner-container)). When it is down, or its root was wiped,
`imp exec` fails with `INNER_DOWN` or `EXEC_FAILED`. `imp exec --agent` runs a command as root in
the agent's own world instead, with busybox, while the container is down too. It needs a token with
host-wide `manage` scope.

```sh
imp exec --agent box -- cat /sys/fs/cgroup/user/cgroup.events   # is anything left inside?
imp exec --agent box -- ls -A /user                              # the user disk
imp exec --agent box -- dmesg
imp exec --agent -t box -- sh                                    # a shell
```

The user disk is at `/user`. A shell there follows the symlinks it finds, and those are the user's:
`cp x /user/link`, where `link` points at `/run`, writes into the agent's world, not the disk. Read
the disk with care, and copy files in and out with `imp cp`, which resolves paths inside the
container. Each command shares 32 MiB of memory with the other outer execs. An imp whose agent
predates protocol `0.16.0` refuses it with `AGENT_OUTDATED`: stop and start the imp to update its
agent.

An outer shell is root in the agent's world. It can kill or ptrace the agent, or `reboot` the guest,
and either one ends the imp.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unauthorized` from the CLI               | Log in again: `imp login <url> --name <host>` with the token from `<IMP_DATA_DIR>/token` (`scripts/dev.sh token`).       |
| A wake logs `cold boot instead of a wake` | The snapshot cannot load on this host; the log and `imp ls` say why. Expected after some upgrades ([upgrade](#upgrade)). |
| An imp never sleeps                       | Something keeps it active: an open connection in the guest, CPU above `IMP_IDLE_CPU_PERCENT`, or a hold.                 |
| TLS downloads stall in a guest            | The uplink MTU is smaller than 1500. `dev.sh` sets `IMP_UPLINK_MTU`; set it by hand elsewhere.                           |
| The tailnet node is `imp-1`               | An old node holds the name. The [Tailscale guide](./tailscale.md#state-and-ephemeral-keys) covers it.                    |
