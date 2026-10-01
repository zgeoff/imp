# Configuration

imp reads environment variables in three places: impd, the host container scripts, and the CLI.
There is no config file. An empty variable counts as unset.

## impd

impd reads these when it starts (`packages/daemon/src/config.ts`). A bad value stops impd with an
error.

| Variable                   | Default           | Meaning                                                                                    |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `IMP_DATA_DIR`             | `/var/lib/imp`    | The data directory ([layout](../architecture/storage.md#the-data-directory)).              |
| `IMP_API_PORT`             | `7070`            | The control API: `/rpc`, `/exec` and `/health`.                                            |
| `IMP_PROXY_PORT`           | `7080`            | The wake proxy with Host-header routing.                                                   |
| `IMP_PORT_BASE`            | `20000`           | The first per-imp proxy port; slot `n` gets `IMP_PORT_BASE + n`.                           |
| `IMP_RAM_BUDGET_MIB`       | `16384`           | The RAM budget for awake imps.                                                             |
| `IMP_IDLE_TIMEOUT_S`       | `60`              | Seconds with no activity before an imp sleeps.                                             |
| `IMP_IDLE_CPU_PERCENT`     | `10`              | Firecracker CPU, in percent of one core, above which an imp counts as busy.                |
| `IMP_BOOT_RESERVE_PERCENT` | `50`              | The RAM reserved before a cold boot, as a percentage of the imp's memory (1–100).          |
| `IMP_WAKE_RESERVE_MIB`     | `256`             | The least RAM reserved before a wake.                                                      |
| `IMP_DEFAULT_VCPUS`        | `2`               | vCPUs for `imp new` without `--cpus`.                                                      |
| `IMP_DEFAULT_MEMORY_MIB`   | `2048`            | Memory for `imp new` without `--memory`.                                                   |
| `IMP_DEFAULT_IMAGE`        | `base`            | The image for `imp new` without `--image`. `ubuntu` is used until one by this name exists. |
| `IMP_DNS`                  | `1.1.1.1,8.8.8.8` | Guest DNS servers, comma-separated IPv4 addresses.                                         |
| `IMP_SUBNET`               | `10.66.0.0/16`    | The pool for guest /30s. `IMP_PORT_BASE` plus the slot count must stay under 65536.        |
| `IMP_FIRECRACKER_BIN`      | `firecracker`     | The Firecracker binary.                                                                    |
| `IMP_KERNEL`               | none              | The guest kernel to copy into `<data>/system/vmlinux` on start.                            |
| `IMP_SYSTEM_DRIVE`         | none              | The system drive to copy into `<data>/system/imp-system.squashfs` on start.                |
| `TAILSCALE_AUTHKEY`        | none              | Set means the host joins the tailnet; impd then reports tailnet URLs.                      |
| `IMP_TAILSCALE_HOSTNAME`   | `imp`             | The tailnet hostname to ask for.                                                           |

[Sleep and wake](../architecture/sleep-and-wake.md#the-ram-governor) explains the RAM and idle
settings.

## Host container

The host container's scripts in `host/` read these before impd starts.

| Variable                  | Default                            | Read by            | Meaning                                                                   |
| ------------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `IMP_STORAGE_GIB`         | `200`                              | `setup-storage.sh` | The size of the sparse XFS loop file.                                     |
| `IMP_STORAGE_FILE`        | `/data/imp.xfs`                    | `setup-storage.sh` | Where the loop file lives. Unused when `/var/lib/imp` is already XFS.     |
| `IMP_SUBNET`              | `10.66.0.0/16`                     | `setup-net.sh`     | The subnet to masquerade. Keep it equal to impd's.                        |
| `IMP_UPLINK_MTU`          | none                               | `setup-net.sh`     | The MTU outside the container, for the TCP MSS clamp. Unset: path MTU.    |
| `TAILSCALE_AUTHKEY`       | none                               | `tailscale-up.sh`  | A tagged auth key. Unset: no tailnet.                                     |
| `IMP_TAILSCALE_HOSTNAME`  | `imp`                              | `tailscale-up.sh`  | The tailnet hostname.                                                     |
| `IMP_TAILSCALE_STATE_DIR` | `/var/lib/imp/tailscale`           | `tailscale-up.sh`  | Node state; `mem` keeps it in memory.                                     |
| `IMP_DNS`                 | `1.1.1.1 8.8.8.8`                  | `tailscale-up.sh`  | Resolvers for the container when its resolv.conf points into the tailnet. |
| `IMP_DAEMON`              | `/src/packages/daemon/src/main.ts` | `entrypoint`       | The impd entry point the supervisor runs.                                 |

**NOTE:** `tailscale-up.sh` splits `IMP_DNS` on spaces, and impd splits it on commas. Set it for
only one of them, or leave it unset.

## Dev instance

`scripts/dev.sh` runs one host container for development. It reads these on your machine:

| Variable              | Default                                        | Meaning                                                |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `IMP_DEV_NAME`        | `imp-dev`                                      | The container name.                                    |
| `IMP_DEV_PORT_OFFSET` | `0`                                            | Added to every published port, for parallel instances. |
| `IMP_DEV_DATA`        | `<repo>/.data/dev`                             | The host directory that holds the XFS file.            |
| `IMP_KERNEL`          | `kernel/out/vmlinux`, else `.cache/vmlinux-ci` | The guest kernel; a path under the repo.               |
| `IMP_SYSTEM_DRIVE`    | `build/imp-system.squashfs`                    | The system drive; a path under the repo.               |
| `IMP_STORAGE_GIB`     | `200`                                          | Passed to the container.                               |
| `IMP_DEFAULT_IMAGE`   | none                                           | Passed to impd.                                        |

`dev.sh` reads `TAILSCALE_AUTHKEY` from `.env` in the repo root and passes the file to Docker, so
the key is never printed. It sets `IMP_UPLINK_MTU` from this machine's default route.

impd tuning passes through an allowlist. When set on your machine, `dev.sh` passes
`IMP_IDLE_TIMEOUT_S`, `IMP_IDLE_CPU_PERCENT`, `IMP_RAM_BUDGET_MIB`, `IMP_BOOT_RESERVE_PERCENT`,
`IMP_WAKE_RESERVE_MIB`, `IMP_DEFAULT_VCPUS`, `IMP_DEFAULT_MEMORY_MIB` and `IMP_TAILSCALE_HOSTNAME`
to impd. Other impd variables keep their defaults in the dev container.

## CLI

| Variable          | Default                 | Meaning                                  |
| ----------------- | ----------------------- | ---------------------------------------- |
| `IMP_URL`         | `http://localhost:7070` | The impd API.                            |
| `IMP_TOKEN`       | none                    | The API token. Wins over the token file. |
| `XDG_CONFIG_HOME` | `~/.config`             | Where the CLI looks for `imp/token`.     |

Without `IMP_TOKEN`, the CLI reads `~/.config/imp/token`. impd writes the token to
`<IMP_DATA_DIR>/token` on first start; `scripts/dev.sh token` prints it.

## Not covered here

Some `IMP_*` variables are internal to the scripts and tests, not settings: `IMP_ROOT`, `IMP_BUILD`,
`IMP_HOST_IMAGE`, `IMP_DATA`, `IMP_ID`, `IMP_CI_KERNEL`, `IMP_SMOKE_IMAGE`, `IMP_BASE_IMAGE` and
`IMP_E2E_*`. `KVER` and `KSHA256` pick the kernel source for `kernel/build.sh`
([kernel README](../../kernel/README.md)).
