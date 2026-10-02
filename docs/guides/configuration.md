# Configuration

imp reads environment variables in three places: impd, the host container scripts, and the CLI.
There is no config file. A server keeps the variables in an env file, `/etc/imp/imp-host.env`
([`deploy/imp-host.env.example`](../../deploy/imp-host.env.example)), which the systemd unit and the
compose file pass to the container. An empty variable counts as unset.

## impd

impd reads these when it starts (`packages/daemon/src/config.ts`). A bad value stops impd with an
error.

| Variable                    | Default           | Meaning                                                                                                                                          |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMP_DATA_DIR`              | `/var/lib/imp`    | The data directory ([layout](../architecture/storage.md#the-data-directory)).                                                                    |
| `IMP_API_PORT`              | `7070`            | The control API: `/rpc`, `/exec`, `/health` and the dashboard.                                                                                   |
| `IMP_PROXY_PORT`            | `7080`            | The wake proxy with Host-header routing.                                                                                                         |
| `IMP_PORT_BASE`             | `20000`           | The first per-imp proxy port; slot `n` gets `IMP_PORT_BASE + n`.                                                                                 |
| `IMP_BROKER_PORT`           | `7081`            | The credential broker on every guest's gateway ([connectors](./connectors.md)). Only guests reach it.                                            |
| `IMP_BROKER_TEST_UPSTREAMS` | none              | Tests only: a file of fake upstreams for granted hosts ([development](./development.md#end-to-end-tests)). impd logs each load.                  |
| `IMP_RAM_BUDGET_MIB`        | `16384`           | The RAM budget for awake imps.                                                                                                                   |
| `IMP_IDLE_TIMEOUT_S`        | `60`              | Seconds with no activity before an imp sleeps.                                                                                                   |
| `IMP_IDLE_CPU_PERCENT`      | `10`              | Firecracker CPU, in percent of one core, above which an imp counts as busy.                                                                      |
| `IMP_BOOT_RESERVE_PERCENT`  | `50`              | The RAM reserved before a cold boot, as a percentage of the imp's memory (1–100).                                                                |
| `IMP_WAKE_RESERVE_MIB`      | `256`             | The least RAM reserved before a wake.                                                                                                            |
| `IMP_DEFAULT_VCPUS`         | `2`               | vCPUs for `imp new` without `--cpus`.                                                                                                            |
| `IMP_DEFAULT_MEMORY_MIB`    | `2048`            | Memory for `imp new` without `--memory`.                                                                                                         |
| `IMP_DEFAULT_IMAGE`         | `base`            | The image for `imp new` without `--image`. `ubuntu` is used until one by this name exists.                                                       |
| `IMP_STORAGE_BACKEND`       | `xfs`             | `xfs` or `zfs` ([storage](../architecture/storage.md)). impd refuses a data dir the other backend wrote.                                         |
| `IMP_ZFS_ROOT`              | none              | With `zfs`: the dataset mounted on `IMP_DATA_DIR`, such as `tank/imp`. Needed then.                                                              |
| `IMP_DNS`                   | `1.1.1.1,8.8.8.8` | Guest DNS servers, comma-separated IPv4 addresses.                                                                                               |
| `IMP_SUBNET`                | `10.66.0.0/16`    | The pool for guest /30s. The last per-imp port, `IMP_PORT_BASE` plus the slot count minus 1, must not pass 65535.                                |
| `IMP_FIRECRACKER_BIN`       | `firecracker`     | The Firecracker binary.                                                                                                                          |
| `IMP_KERNEL`                | none              | The guest kernel to copy into `<data>/system/vmlinux` on start. The release image sets its own.                                                  |
| `IMP_SYSTEM_DRIVE`          | none              | The system drive to copy into `<data>/system/drives/` on start; without it, `<data>/system/imp-system.squashfs`. The release image sets its own. |
| `TAILSCALE_AUTHKEY`         | none              | Set means the host joins the tailnet; impd then reports tailnet URLs.                                                                            |
| `IMP_TAILSCALE_HOSTNAME`    | `imp`             | The tailnet hostname to ask for.                                                                                                                 |
| `IMP_DASHBOARD_DIR`         | none              | The [dashboard](./dashboard.md)'s built files, served at `/ui/`. The release image sets its own.                                                 |

[Sleep and wake](../architecture/sleep-and-wake.md#the-ram-governor) explains the RAM and idle
settings.

## Host container

The host container's scripts in `host/` read these before impd starts.

| Variable                  | Default                            | Read by            | Meaning                                                                                                            |
| ------------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `IMP_STORAGE_BACKEND`     | `xfs`                              | `setup-storage.sh` | `zfs` mounts `IMP_ZFS_ROOT` on `/var/lib/imp` and skips the loop file.                                             |
| `IMP_ZFS_ROOT`            | none                               | `setup-storage.sh` | The dataset to mount; it must have `mountpoint=legacy`.                                                            |
| `IMP_STORAGE_LOOP`        | `1`; `0` in the release image      | `setup-storage.sh` | `1` loop-mounts `IMP_STORAGE_FILE` when nothing is mounted at `/var/lib/imp`; `0` refuses to start.                |
| `IMP_STORAGE_GIB`         | `200`                              | `setup-storage.sh` | The size of the sparse XFS loop file.                                                                              |
| `IMP_STORAGE_FILE`        | `/data/imp.xfs`                    | `setup-storage.sh` | Where the loop file lives. Unused when `/var/lib/imp` is already XFS.                                              |
| `IMP_SUBNET`              | `10.66.0.0/16`                     | `setup-net.sh`     | The subnet to masquerade. Keep it equal to impd's.                                                                 |
| `IMP_UPLINK_MTU`          | none                               | `setup-net.sh`     | The MTU outside the container, for the TCP MSS clamp. Unset: path MTU.                                             |
| `TAILSCALE_AUTHKEY`       | none                               | `tailscale-up.sh`  | A tagged auth key. Unset: no tailnet.                                                                              |
| `IMP_TAILSCALE_HOSTNAME`  | `imp`                              | `tailscale-up.sh`  | The tailnet hostname.                                                                                              |
| `IMP_TAILSCALE_STATE_DIR` | `/var/lib/imp/tailscale`           | `tailscale-up.sh`  | Node state; `mem` keeps it in memory.                                                                              |
| `IMP_DNS`                 | `1.1.1.1,8.8.8.8`                  | `tailscale-up.sh`  | Resolvers for the container when its resolv.conf points into the tailnet.                                          |
| `IMP_DAEMON`              | `/src/packages/daemon/src/main.ts` | `entrypoint`       | The impd the supervisor runs: a `.ts` file under bun, else a binary. The release image sets `/usr/local/bin/impd`. |

**NOTE:** impd and `tailscale-up.sh` read the same `IMP_DNS`, a comma-separated list. `dev.sh` does
not pass `IMP_DNS`, so the dev instance uses the defaults.

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
`IMP_WAKE_RESERVE_MIB`, `IMP_DEFAULT_VCPUS`, `IMP_DEFAULT_MEMORY_MIB`, `IMP_TAILSCALE_HOSTNAME`,
`IMP_STORAGE_BACKEND` and `IMP_ZFS_ROOT` to impd. Other impd variables keep their defaults in the
dev container. A ZFS dev instance needs the zfs module on the machine; `scripts/zfs-host-test.sh`
runs one on a throwaway pool.

## CLI

The CLI keeps named impd hosts in `~/.config/imp/config.json` (under `XDG_CONFIG_HOME` when set).
The file holds each host's URL and token, so the CLI writes it with mode 0600 and warns when other
users can read it. No command prints a token.

```sh
imp login https://imp.example.ts.net             # asks for the token; saves the host "imp"
scripts/dev.sh token | imp login http://localhost:7070 --name dev
imp hosts                                         # the saved hosts; * marks the current one
imp host use dev                                  # make another host current
imp --host imp ls                                 # one call to a host other than the current
imp host rm dev
```

`imp login` reads the token from piped stdin, or asks for it at a prompt that does not echo. It
checks the token with impd and saves the host only when impd accepts it. `--no-verify` skips the
check, and `--name` sets the host name; the default is the first label of the URL's hostname. The
CLI warns when you log in over plain http to a host that is not loopback.

The CLI takes the impd URL and its token from one source, the first of these that is set:

1. `--host <name>`: that saved host's URL and token.
2. `IMP_HOST=<name>`: the same, for a whole shell.
3. `IMP_URL`: that URL, with `IMP_TOKEN` as its token, or no token.
4. The current saved host (`imp host use`), with `IMP_TOKEN` in place of its token when set.
5. `http://localhost:7070` with `IMP_TOKEN`, or the token in `~/.config/imp/token`.

So a saved token never goes to the URL in `IMP_URL`, and `IMP_TOKEN` never goes to a host that
`--host` or `IMP_HOST` names. An empty variable counts as unset.

| Variable          | Default     | Meaning                                                                    |
| ----------------- | ----------- | -------------------------------------------------------------------------- |
| `IMP_HOST`        | none        | A saved host name, as `--host` takes. A URL here is an error: use IMP_URL. |
| `IMP_URL`         | none        | The impd API, without any saved host.                                      |
| `IMP_TOKEN`       | none        | The API token for `IMP_URL`, the current host or the local impd.           |
| `XDG_CONFIG_HOME` | `~/.config` | Where the CLI looks for `imp/config.json` and `imp/token`.                 |

`IMP_HOST` is a CLI setting. The `IMP_HOST_IMAGE`, `IMP_HOST_ENV_FILE` and `IMP_HOST_DATA` variables
are for the deploy files and have nothing to do with it.

impd writes the token to `<IMP_DATA_DIR>/token` on first start; `scripts/dev.sh token` prints it.

### Shell completions

`imp completion bash|zsh|fish` prints a completion script for commands and flags. The Homebrew
formula installs all three, once the tap is set up. By hand:

```sh
eval "$(imp completion bash)"                    # in ~/.bashrc
imp completion zsh > "${fpath[1]}/_imp"          # or eval "$(imp completion zsh)" in ~/.zshrc
imp completion fish > ~/.config/fish/completions/imp.fish
```

## Not covered here

Some `IMP_*` variables are internal to the scripts and tests, not settings: `IMP_ROOT`, `IMP_BUILD`,
`IMP_HOST_IMAGE`, `IMP_DATA`, `IMP_ID`, `IMP_CI_KERNEL`, `IMP_SMOKE_IMAGE`, `IMP_BASE_IMAGE` and
`IMP_E2E_*`. `IMP_HOST_IMAGE`, `IMP_HOST_ENV_FILE` and `IMP_HOST_DATA` pick the image, the env file
and the data directory for `deploy/`. `IMP_VERSION` and `IMP_RELEASE_IMAGE` name the image
`host/build-release.sh` builds. `KVER` and `KSHA256` pick the kernel source for `kernel/build.sh`
([kernel README](../../kernel/README.md)).
