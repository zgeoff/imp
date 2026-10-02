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

Use `restart` after a change to impd's code: the entrypoint restarts impd, and nothing in the guests
notices. Use `reboot` after a change to `host/`. Data stays in `.data/dev` across all three.

After a crash (impd or the container killed without a signal), an imp with no live VM comes back
`stopped` and boots cold on the next use. Its disk is intact; its memory is lost. Sleeping imps stay
asleep. [Sleep and wake](../architecture/sleep-and-wake.md#restarts) has the details.

## Upgrade

`deploy/upgrade.sh` moves a server to a new release image. Pass `--compose deploy/compose.yaml` when
the host runs under compose; the default is the systemd unit. It needs `docker`, `curl` and `jq`.

```sh
deploy/upgrade.sh
```

1. It pulls `IMP_HOST_IMAGE` (from the environment, else `/etc/imp/imp-host.env`). It stops there
   when the host already runs that image.
2. It sleeps every awake imp through the API, one at a time. If the list or one sleep fails, it
   stops and the host keeps the old image. The stop would sleep them too, but only within its 120 s.
3. It restarts the host, waits for `/health` to report ready, prints the old image ID for a roll
   back, prints the boot status counts from `imp info`, and lists the imps.

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
a child that ignores SIGTERM (a `nohup` job, say) keeps running until the imp restarts.

An impd from before this scheme kept the drive at `/var/lib/imp/system/imp-system.squashfs`, and a
VM it booted still runs from that file. impd leaves the file alone. Remove it once no such VM runs:
`imp ls` shows none with `booted by an older impd`.

**Roll back** with `docker tag <old image ID> <image>` and the same restart. A rollback to an impd
from before this upgrade scheme (the first release with `system/drives/`) does not match the hashes
in the new snapshot records, and every sleeping imp boots cold once. The same happens once the other
way: an older impd hashed the drive with another hash and wrote no drive path, so its snapshots boot
cold with `the snapshot is from an older impd`.

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

## Backups

With `IMP_BACKUP_REPOSITORY` set, impd backs up every imp to a restic repository on a schedule
([backups](../architecture/backups.md), [settings](./configuration.md#backups)).

- `imp backup ls` shows the restore points and the last prune and check.
- `impd: backup: CHECK FAILED` in the log, or `FAILED` in `imp backup ls`, means the repository may
  be damaged: run `imp backup check --subset 100%`, then repair it with `restic repair`
  ([restic docs](https://restic.readthedocs.io/en/stable/077_troubleshooting.html)) from a machine
  with the password.
- `imp backup restore <name> --as <new>` restores next to the original; restored imps are stopped.

## Logs

- `scripts/dev.sh logs` follows impd. Every boot, sleep and wake logs a line with its time and a
  breakdown per step.
- Each imp's serial console and Firecracker log go to `/var/lib/imp/imps/<id>/run/firecracker.log`
  in the container (`scripts/dev.sh shell`).
- A service's output goes to `/var/log/imp/<name>.log` inside the imp.

## Checks

`scripts/test-e2e.sh --clean` drives a real instance through every feature, one suite each:
lifecycle, Docker, bring-your-own images, checkpoints and forks, sleep and wake (with the WebSocket
relay), the scale test, restart survival, Tailscale and the backup restore drill.
[STATUS.md](../../STATUS.md) has the latest results. The [development guide](./development.md) lists
the other checks.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unauthorized` from the CLI               | Log in again: `imp login <url> --name <host>` with the token from `<IMP_DATA_DIR>/token` (`scripts/dev.sh token`).       |
| A wake logs `cold boot instead of a wake` | The snapshot cannot load on this host; the log and `imp ls` say why. Expected after some upgrades ([upgrade](#upgrade)). |
| An imp never sleeps                       | Something keeps it active: an open connection in the guest, CPU above `IMP_IDLE_CPU_PERCENT`, or a hold.                 |
| TLS downloads stall in a guest            | The uplink MTU is smaller than 1500. `dev.sh` sets `IMP_UPLINK_MTU`; set it by hand elsewhere.                           |
| The tailnet node is `imp-1`               | An old node holds the name. The [Tailscale guide](./tailscale.md#state-and-ephemeral-keys) covers it.                    |
