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

| Symptom                                   | Cause and fix                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `unauthorized` from the CLI               | Set `IMP_TOKEN`, or write the token to `~/.config/imp/token` (`scripts/dev.sh token` prints it).                |
| A wake logs `cold boot instead of a wake` | The snapshot does not match this host (Firecracker, kernel or system drive changed). Expected after an upgrade. |
| An imp never sleeps                       | Something keeps it active: an open connection in the guest, CPU above `IMP_IDLE_CPU_PERCENT`, or a hold.        |
| TLS downloads stall in a guest            | The uplink MTU is smaller than 1500. `dev.sh` sets `IMP_UPLINK_MTU`; set it by hand elsewhere.                  |
| The tailnet node is `imp-1`               | An old node holds the name. The [Tailscale guide](./tailscale.md#state-and-ephemeral-keys) covers it.           |
