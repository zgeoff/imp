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
the host runs under compose; the default is the systemd unit.

```sh
deploy/upgrade.sh
```

1. It pulls `IMP_HOST_IMAGE` (from the environment, else `/etc/imp/imp-host.env`). It stops there
   when the host already runs that image.
2. It sleeps every awake imp through the API, one at a time. If one fails to sleep, it stops and the
   host keeps the old image. The stop would sleep them too, but only within its 120 s.
3. It restarts the host, waits for `/health` to report ready, prints the old image ID for a roll
   back, and lists the imps.

Imps then wake on demand. Each sleeping imp either restores its memory or boots its disk cold. The
disk is never touched. [Snapshot identity](../architecture/sleep-and-wake.md#snapshot-identity) has
the full rule:

- A new impd alone, or a new agent drive: memory restores. impd keeps the old drive while a snapshot
  needs it, and the woken imp runs its old agent until its next cold boot.
- A new guest kernel: memory restores, and the imp runs its old kernel until its next cold boot.
- A new Firecracker or host kernel: every sleeping imp boots cold.

`imp ls` says what an upgrade means for each imp in its NOTE column:

| NOTE                    | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `boots cold: <reason>`  | A sleeping imp whose snapshot cannot load; its next wake boots the disk.  |
| `booted cold: <reason>` | An awake imp whose last wake became a cold boot, and why.                 |
| `outdated: agent`       | The imp runs an older agent, kernel or Firecracker than the host has now. |

To pick up the new agent or kernel in an outdated imp, run `imp stop <name>` and `imp start <name>`.
It loses its memory, not its disk. impd deletes the old drive on its next start, once no imp uses
it.

**Roll back** with `docker tag <old image ID> <image>` and the same restart. A rollback to an impd
from before this upgrade scheme (the first release with `system/drives/`) does not match the hashes
in the new snapshot records, and every sleeping imp boots cold once. The same happens once the other
way: an older impd hashed the drive with another hash and wrote no drive path, so its snapshots boot
cold with `the snapshot is from an older impd`.

## The RAM budget

impd keeps the RAM of awake imps under `IMP_RAM_BUDGET_MIB`. `imp info` shows the budget, the
measured use, the committed memory of awake imps, and the imp counts.

- When a boot or a wake would go over, impd sleeps the least recently active imps first.
- An imp with an open session, a request in flight or a hold is never picked.
- When nothing can make room, the request fails with `RAM_BUDGET_EXCEEDED`. Free room with
  `imp sleep` or `imp stop`, or raise the budget.

To keep an imp awake on purpose, hold it: `imp hold box 2h`. `imp hold box 0` releases it.

## Logs

- `scripts/dev.sh logs` follows impd. Every boot, sleep and wake logs a line with its time and a
  breakdown per step.
- Each imp's serial console and Firecracker log go to `/var/lib/imp/imps/<id>/run/firecracker.log`
  in the container (`scripts/dev.sh shell`).
- A service's output goes to `/var/log/imp/<name>.log` inside the imp.

## Checks

`scripts/acceptance.sh --clean` drives a real instance through every feature: shell, Docker,
bring-your-own images, checkpoints and forks, sleep and wake, the scale test, restart survival and
Tailscale. [STATUS.md](../../STATUS.md) has the latest results. The
[development guide](./development.md) lists the other checks.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `unauthorized` from the CLI               | Set `IMP_TOKEN`, or write the token to `~/.config/imp/token` (`scripts/dev.sh token` prints it).                         |
| A wake logs `cold boot instead of a wake` | The snapshot cannot load on this host; the log and `imp ls` say why. Expected after some upgrades ([upgrade](#upgrade)). |
| An imp never sleeps                       | Something keeps it active: an open connection in the guest, CPU above `IMP_IDLE_CPU_PERCENT`, or a hold.                 |
| TLS downloads stall in a guest            | The uplink MTU is smaller than 1500. `dev.sh` sets `IMP_UPLINK_MTU`; set it by hand elsewhere.                           |
| The tailnet node is `imp-1`               | An old node holds the name. The [Tailscale guide](./tailscale.md#state-and-ephemeral-keys) covers it.                    |
