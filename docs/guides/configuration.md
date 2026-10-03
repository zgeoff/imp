# Configuration

imp reads environment variables in three places: impd, the host container scripts, and the CLI.
There is no config file. A server keeps the variables in an env file, `/etc/imp/imp-host.env`
([`deploy/imp-host.env.example`](../../deploy/imp-host.env.example)), which the systemd unit and the
compose file pass to the container. An empty variable counts as unset.

## impd

impd reads these when it starts (`packages/daemon/src/config.ts`). A bad value stops impd with an
error.

| Variable                        | Default                           | Meaning                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMP_DATA_DIR`                  | `/var/lib/imp`                    | The data directory ([layout](../architecture/storage.md#the-data-directory)).                                                                                                                                                                                     |
| `IMP_API_PORT`                  | `7070`                            | The control API: `/rpc`, `/exec`, `/health` and the dashboard.                                                                                                                                                                                                    |
| `IMP_PROXY_PORT`                | `7080`                            | The wake proxy with Host-header routing.                                                                                                                                                                                                                          |
| `IMP_PORT_BASE`                 | `20000`                           | The first per-imp proxy port; slot `n` gets `IMP_PORT_BASE + n`. impd refuses an API or proxy port inside the imp ports.                                                                                                                                          |
| `IMP_SSH_PORT`                  | `22`                              | The [SSH gateway](./ssh.md), on IPv4 in the container's namespace. `0` turns it off.                                                                                                                                                                              |
| `IMP_SSH_AUTHORIZED_KEYS`       | `true`                            | `false`: keys in `<data>/ssh/authorized_keys` log in nowhere; only [keys bound to tokens](./ssh.md#keys-bound-to-tokens) do.                                                                                                                                      |
| `IMP_BROKER_PORT`               | `7081`                            | The credential broker on every guest's gateway ([connectors](./connectors.md)). Only guests reach it.                                                                                                                                                             |
| `IMP_EGRESS_DNS_PORT`           | `7053`                            | The egress resolver on every guest's gateway ([egress](../architecture/networking.md#egress)). Only guests reach it.                                                                                                                                              |
| `IMP_BROKER_TEST_UPSTREAMS`     | none                              | Tests only: a file of fake upstreams for granted hosts ([development](./development.md#end-to-end-tests)). impd logs each load.                                                                                                                                   |
| `IMP_RAM_BUDGET_MIB`            | `16384`                           | The RAM budget for awake imps.                                                                                                                                                                                                                                    |
| `IMP_IDLE_TIMEOUT_S`            | `60`                              | Seconds with no activity before an imp sleeps.                                                                                                                                                                                                                    |
| `IMP_IDLE_CPU_PERCENT`          | `10`                              | Firecracker CPU, in percent of one core, above which an imp counts as busy.                                                                                                                                                                                       |
| `IMP_BOOT_RESERVE_PERCENT`      | `50`                              | The RAM reserved before a cold boot, as a percentage of the imp's memory (1–100).                                                                                                                                                                                 |
| `IMP_BOOT_TEMPLATES`            | `true`                            | A cold boot restores a parked guest of its shape; `false` boots the kernel ([boot templates](../architecture/boot-templates.md)).                                                                                                                                 |
| `IMP_WAKE_RESERVE_MIB`          | `256`                             | The least RAM reserved before a wake.                                                                                                                                                                                                                             |
| `IMP_SLEEP_MIN_GUEST_UPTIME_MS` | `1500`                            | A sleep first waits until the guest has been up this long; `0` turns the wait off ([young guests](../architecture/sleep-and-wake.md#young-guests)).                                                                                                               |
| `IMP_WATCHDOG_TIMEOUT_S`        | `60`                              | Seconds an agent may stay silent before the [watchdog](../architecture/sleep-and-wake.md#the-watchdog) acts.                                                                                                                                                      |
| `IMP_WATCHDOG_ACTION`           | `report`                          | What the watchdog does then: `report`, `restart` (boot cold), or `snapshot` (keep the memory, then boot cold).                                                                                                                                                    |
| `IMP_DEFAULT_VCPUS`             | `2`                               | vCPUs for `imp new` without `--cpus`.                                                                                                                                                                                                                             |
| `IMP_DEFAULT_MEMORY_MIB`        | `2048`                            | Memory for `imp new` without `--memory`.                                                                                                                                                                                                                          |
| `IMP_DEFAULT_DISK_GIB`          | `32`                              | Disk for `imp new` without `--disk`; never less than the image's filesystem.                                                                                                                                                                                      |
| `IMP_DISK_RESERVE_GIB`          | 5 % of the disk, at least 5       | Free space no write may take: creates, sleeps and image builds past it fail with `DISK_FULL` ([storage](../architecture/storage.md#disk-budget)).                                                                                                                 |
| `IMP_DEFAULT_IMAGE`             | `base`                            | The image for `imp new` without `--image`. `ubuntu` is used until one by this name exists.                                                                                                                                                                        |
| `IMP_BUILD_CONTEXT_MAX_MIB`     | `1024`                            | The largest build context `imp image build` may upload ([images](./images.md#build-an-image)).                                                                                                                                                                    |
| `IMP_KSM`                       | none                              | `1` lets KSM merge identical guest pages: Firecracker, or the jailer that execs it, starts through `ksm-exec`; `0` or unset is off. Linux 6.10 or later; a single-owner trade-off ([KSM](../architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages)). |
| `IMP_KSM_HEADROOM_PERCENT`      | `100`                             | With `IMP_KSM` (read only then): the share of what KSM saves in the awake VMs that the governor keeps free. 100 is safe; lower fits more imps.                                                                                                                    |
| `IMP_KSM_EXEC`                  | `ksm-exec`                        | With `IMP_KSM`: the wrapper Firecracker, or the jailer, starts through. It runs outside the jail, so the chroot needs no copy.                                                                                                                                    |
| `IMP_STORAGE_BACKEND`           | `xfs`                             | `xfs` or `zfs` ([storage](../architecture/storage.md)). impd refuses a data dir the other backend wrote.                                                                                                                                                          |
| `IMP_ZFS_ROOT`                  | none                              | With `zfs`: the dataset mounted on `IMP_DATA_DIR`, such as `tank/imp`. Needed then.                                                                                                                                                                               |
| `IMP_DNS`                       | `1.1.1.1,8.8.8.8`                 | Guest DNS servers, comma-separated IPv4 addresses; also the egress resolver's upstreams.                                                                                                                                                                          |
| `IMP_EGRESS_DENY`               | none                              | More addresses no `public` imp reaches: comma-separated IPv4 or IPv6 addresses and CIDRs. List each Docker host address that `IMP_HOST_ADDRESSES` misses; impd cannot see them ([public](../architecture/networking.md#public)). `IMP_PUBLIC_IP` is always in it. |
| `IMP_HOST_ADDRESSES`            | none                              | The Docker host's own addresses, which no `public` imp reaches. `deploy/imp-host.service` and the NixOS module write it at each start from `ip -o addr show scope global`; set `IMP_EGRESS_DENY` instead.                                                         |
| `IMP_SUBNET`                    | `10.66.0.0/16`                    | The pool for guest /30s. The last per-imp port, `IMP_PORT_BASE` plus the slot count minus 1, must not pass 65535. It must not overlap `100.64.0.0/10`.                                                                                                            |
| `IMP_SUBNET6`                   | `auto`                            | IPv6: `auto`, a /64 or `off` ([IPv6](../architecture/networking.md#ipv6)). `auto` needs IPv6 on the container's network ([IPv6](./install.md#ipv6)).                                                                                                              |
| `IMP_FIRECRACKER_BIN`           | `firecracker`                     | The Firecracker binary.                                                                                                                                                                                                                                           |
| `IMP_JAILER`                    | `true`                            | Run each VM under Firecracker's jailer: a chroot, its own uid, seccomp. Needs cgroup delegation ([the jailer](../architecture/daemon.md#the-jailer)).                                                                                                             |
| `IMP_JAILER_BIN`                | `jailer`                          | The jailer binary.                                                                                                                                                                                                                                                |
| `IMP_KERNEL`                    | none                              | The guest kernel to copy into `<data>/system/vmlinux` on start. The release image sets its own.                                                                                                                                                                   |
| `IMP_SYSTEM_DRIVE`              | none                              | The system drive to copy into `<data>/system/drives/` on start; without it, `<data>/system/imp-system.squashfs`. The release image sets its own.                                                                                                                  |
| `TAILSCALE_AUTHKEY`             | none                              | Set, or `IMP_TAILSCALE_NODE=1`, means the host is on the tailnet; impd then reports tailnet URLs.                                                                                                                                                                 |
| `IMP_TAILSCALE_NODE`            | none                              | `1` when the entrypoint started `tailscaled` from saved node state, with no key. The entrypoint sets it.                                                                                                                                                          |
| `IMP_TAILSCALE_HOSTNAME`        | `imp`                             | The tailnet hostname to ask for.                                                                                                                                                                                                                                  |
| `IMP_TAILNET_NAMES`             | none                              | `1` gives each imp a name of its own on the tailnet, as a Tailscale Service ([per-imp names](./tailscale.md#per-imp-names)). Needs the host on the tailnet.                                                                                                       |
| `IMP_TAILNET_NAME_PREFIX`       | none                              | A prefix for every per-imp name, such as `imp-`.                                                                                                                                                                                                                  |
| `IMP_TAILNET_OAUTH_FILE`        | `<data>/tailnet-names/oauth.json` | The OAuth client for per-imp names: JSON with `clientId` and `clientSecret`, mode 0600.                                                                                                                                                                           |
| `IMP_TAILNET_IDENTITIES`        | none                              | JSON rules that give tailnet members a scope without a token ([tokens](./tokens.md#tailnet-identity)). Unset, every caller needs a token.                                                                                                                         |
| `IMP_PEER_URL`                  | the tailnet IP and `IMP_API_PORT` | The URL a source uses to [move](./hosts.md#moves) an imp here. It must name a literal tailnet address; impd refuses to start otherwise.                                                                                                                           |
| `IMP_MOVE_TEST_CIDR`            | none                              | Tests only, with `IMP_E2E=1`: one more private range, /16 or narrower, that moves may come from and go to, off the tailnet ([moves](../architecture/moves.md#the-steps)). impd logs a warning at start.                                                           |
| `IMP_DASHBOARD_DIR`             | none                              | The [dashboard](./dashboard.md)'s built files, served at `/ui/`. The release image sets its own.                                                                                                                                                                  |

A host on Linux 6.7 or later does not set a restored TSC back, so it can set
`IMP_SLEEP_MIN_GUEST_UPTIME_MS=0`: `scripts/bench-wake.sh` with that setting confirms it, with a
fast median wake ([young guests](../architecture/sleep-and-wake.md#young-guests)).

[Sleep and wake](../architecture/sleep-and-wake.md#the-ram-governor) explains the RAM and idle
settings.

### Backups

impd backs up to a restic repository when `IMP_BACKUP_REPOSITORY` is set
([backups](../architecture/backups.md)). restic reads the repository's keys from the environment as
well: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for S3, `B2_*` for B2. impd passes restic
those, never the rest of its environment.

| Variable                   | Default                      | Meaning                                                                                                        |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `IMP_BACKUP_REPOSITORY`    | none                         | A restic repository, such as `s3:https://s3.example.com/bucket/imp`; the bucket must exist. Unset: no backups. |
| `IMP_BACKUP_PASSWORD_FILE` | none                         | The file that holds the repository password. Needed with a repository. Mode 0600; keep a copy off the host.    |
| `IMP_BACKUP_INTERVAL_S`    | `21600`                      | Seconds between scheduled runs.                                                                                |
| `IMP_BACKUP_KEEP`          | `hourly=24,daily=7,weekly=4` | What `forget` keeps; a bucket left out keeps none.                                                             |
| `IMP_BACKUP_FORGET`        | `true`                       | `false` leaves `forget` and `prune` to one other machine, for a bucket that denies impd's key deletes.         |
| `IMP_BACKUP_CPUS`          | `2`                          | restic's `GOMAXPROCS`.                                                                                         |
| `IMP_BACKUP_MEMORY_MIB`    | `512`                        | restic's `GOMEMLIMIT`, a soft limit.                                                                           |

### HTTPS

With `IMP_DOMAIN` set, impd serves every imp at `https://<name>.<domain>` on the tailnet
([HTTPS](./https.md)). Without it, impd ignores the rest of these.

| Variable                 | Default        | Meaning                                                                                                                                                             |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMP_DOMAIN`             | none           | The domain: imps at `<name>.<domain>`, impd's API at `<domain>`.                                                                                                    |
| `IMP_DNS_PROVIDER`       | none           | `cloudflare`, or `challtestsrv` with `IMP_E2E=1` in tests. Needed with `IMP_DOMAIN`.                                                                                |
| `IMP_DNS_API_TOKEN`      | none           | The provider's API token; a secret ([HTTPS](./https.md#set-it-up)). Cloudflare needs it or `IMP_DNS_API_TOKEN_FILE`.                                                |
| `IMP_DNS_API_TOKEN_FILE` | none           | A file that holds the token, read at each API call, so a new token works without a restart ([HTTPS](./https.md#the-token-in-a-file)). Not with `IMP_DNS_API_TOKEN`. |
| `IMP_DNS_API_URL`        | the provider's | The provider's API, https unless on loopback. Needed for `challtestsrv`: its management URL.                                                                        |
| `IMP_ACME_DIRECTORY`     | Let's Encrypt  | The ACME directory URL. Staging is `https://acme-staging-v02.api.letsencrypt.org/directory`.                                                                        |
| `IMP_ACME_EMAIL`         | none           | The contact on the ACME account.                                                                                                                                    |
| `IMP_ACME_CA_FILE`       | none           | A PEM file the ACME server's own TLS chains to, for a test CA such as Pebble.                                                                                       |
| `IMP_HTTPS_PORT`         | `443`          | The HTTPS port on the tailnet IP and loopback.                                                                                                                      |
| `IMP_HTTP_PORT`          | `80`           | The port that redirects to HTTPS.                                                                                                                                   |

[Public imps](./https.md#public-imps) need `IMP_DOMAIN` too. Without `IMP_PUBLIC_IP`, every imp is
tailnet-only and `imp expose` fails.

| Variable                | Default | Meaning                                                                                 |
| ----------------------- | ------- | --------------------------------------------------------------------------------------- |
| `IMP_PUBLIC_IP`         | none    | The host's public IPv4. Each public imp's A record points at it.                        |
| `IMP_PUBLIC_HTTPS_PORT` | `7443`  | The public TLS listener's port in the host container, on every address; publish as 443. |
| `IMP_PUBLIC_HTTP_PORT`  | `7480`  | The public redirect listener's port in the host container; publish as 80.               |

### Telemetry

impd exports [metrics and spans](./events.md#telemetry) only when `OTEL_EXPORTER_OTLP_ENDPOINT` is
set. The OTLP exporters read the other standard `OTEL_EXPORTER_OTLP_*` variables themselves.

| Variable                      | Default | Meaning                                                                      |
| ----------------------------- | ------- | ---------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none    | The collector's base URL, such as `http://collector:4318`. Unset: no export. |
| `OTEL_EXPORTER_OTLP_HEADERS`  | none    | Headers on every export, as `key=value,key=value`, such as an API key.       |
| `OTEL_SERVICE_NAME`           | `impd`  | The `service.name` on everything impd sends.                                 |

## Host container

The host container's scripts in `host/` read these before impd starts.

| Variable                     | Default                            | Read by            | Meaning                                                                                                            |
| ---------------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `IMP_STORAGE_BACKEND`        | `xfs`                              | `setup-storage.sh` | `zfs` mounts `IMP_ZFS_ROOT` on `/var/lib/imp` and skips the loop file.                                             |
| `IMP_ZFS_ROOT`               | none                               | `setup-storage.sh` | The dataset to mount; it must have `mountpoint=legacy`.                                                            |
| `IMP_STORAGE_LOOP`           | `1`; `0` in the release image      | `setup-storage.sh` | `1` loop-mounts `IMP_STORAGE_FILE` when nothing is mounted at `/var/lib/imp`; `0` refuses to start.                |
| `IMP_STORAGE_GIB`            | `200`                              | `setup-storage.sh` | The size of the sparse XFS loop file.                                                                              |
| `IMP_STORAGE_FILE`           | `/data/imp.xfs`                    | `setup-storage.sh` | Where the loop file lives. Unused when `/var/lib/imp` is already XFS.                                              |
| `IMP_SUBNET`                 | `10.66.0.0/16`                     | `setup-net.sh`     | The subnet to masquerade. Keep it equal to impd's.                                                                 |
| `IMP_UPLINK_MTU`             | none                               | `setup-net.sh`     | The MTU outside the container, for the TCP MSS clamp (less 40, or 60 for IPv6). Unset: path MTU.                   |
| `TAILSCALE_AUTHKEY`          | none                               | `tailscale-up.sh`  | A tagged auth key. Unset: the saved node state, if any, else no tailnet.                                           |
| `IMP_TAILSCALE_AUTHKEY_FILE` | none                               | `tailscale-up.sh`  | A file that holds the key instead, read by `tailscale` only to join.                                               |
| `IMP_TAILSCALE_HOSTNAME`     | `imp`                              | `tailscale-up.sh`  | The tailnet hostname.                                                                                              |
| `IMP_TAILSCALE_STATE_DIR`    | `/var/lib/imp/tailscale`           | `tailscale-up.sh`  | Node state; `mem` keeps it in memory.                                                                              |
| `IMP_DNS`                    | `1.1.1.1,8.8.8.8`                  | `tailscale-up.sh`  | Resolvers for the container when its resolv.conf points into the tailnet.                                          |
| `IMP_DAEMON`                 | `/src/packages/daemon/src/main.ts` | `entrypoint`       | The impd the supervisor runs: a `.ts` file under bun, else a binary. The release image sets `/usr/local/bin/impd`. |

**NOTE:** impd and `tailscale-up.sh` read the same `IMP_DNS`, a comma-separated list. `dev.sh` does
not pass `IMP_DNS`, so the dev instance uses the defaults.

**NOTE:** CPU limits need the container in a private cgroup namespace:
`docker run --cgroupns=private` (`cgroup: private` in Compose). `setup-cgroups.sh` turns them off
without it ([CPU limits](./cpu-limits.md)).

## Dev instance

`scripts/dev.sh` runs one host container for development. It reads these on your machine:

| Variable              | Default                                        | Meaning                                                         |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `IMP_DEV_NAME`        | `imp-dev`                                      | The container name.                                             |
| `IMP_DEV_PORT_OFFSET` | `0`                                            | Added to every published port, for parallel instances.          |
| `IMP_DEV_DATA`        | `<repo>/.data/dev`                             | The host directory that holds the XFS file.                     |
| `IMP_KERNEL`          | `kernel/out/vmlinux`, else `.cache/vmlinux-ci` | The guest kernel; a path under the repo.                        |
| `IMP_SYSTEM_DRIVE`    | `build/imp-system.squashfs`                    | The system drive; a path under the repo.                        |
| `IMP_STORAGE_GIB`     | `200`                                          | Passed to the container.                                        |
| `IMP_DEFAULT_IMAGE`   | none                                           | Passed to impd.                                                 |
| `IMP_DEV_NETWORK`     | none                                           | A Docker network for the container.                             |
| `IMP_DEV_IP`          | none                                           | The container's address on `IMP_DEV_NETWORK`.                   |
| `IMP_DEV_PUBLISH`     | `1`                                            | `0` publishes no ports: impd answers on `IMP_DEV_IP:7070` only. |
| `IMP_DEV_TAILNET`     | none                                           | `0` keeps the container off the tailnet, whatever key there is. |
| `IMP_HOST_IMAGE`      | `imp-host:dev-<dir>-<hash>`                    | The host image tag, one per checkout.                           |

`dev.sh` passes `.env` in the repo root to Docker as an env file, so `IMP_DNS_API_TOKEN` and any
other secret in it is never printed. It takes `TAILSCALE_AUTHKEY` from the first of:

1. `TAILSCALE_AUTHKEY` in your environment.
2. `op read "$IMP_TAILSCALE_AUTHKEY_REF"`, only when `IMP_TAILSCALE_OP=1`, the 1Password CLI is on
   `PATH` and the read works. The e2e harness sets `IMP_TAILSCALE_OP=1` only when the run includes
   the tailscale suite, so other runs and other worktrees' dev instances stay off the tailnet. The
   reference defaults to `op://cloud/imp-tailscale-authkey/credential`. The read gets 20 seconds, so
   a locked 1Password app cannot hang a run. A failed read stays quiet, falls through, and sets
   `IMP_TAILSCALE_OP_MISSED=1`, so the rest of the run (a reboot, the e2e harness's later steps)
   skips `op`.
3. `TAILSCALE_AUTHKEY` in `.env`.

With none of them, the dev instance stays off the tailnet. The key reaches Docker as
`-e TAILSCALE_AUTHKEY` with no value, so it never shows in argv, and `bash -x` traces never show it.
`load_tailscale_authkey` in `scripts/lib.sh` holds the order; the e2e harness uses it too.

`dev.sh` sets `IMP_UPLINK_MTU` from this machine's default route, unless it is set.

impd tuning passes through an allowlist. When set on your machine, `dev.sh` passes
`IMP_IDLE_TIMEOUT_S`, `IMP_IDLE_CPU_PERCENT`, `IMP_RAM_BUDGET_MIB`, `IMP_BOOT_RESERVE_PERCENT`,
`IMP_BOOT_TEMPLATES`, `IMP_WAKE_RESERVE_MIB`, `IMP_SLEEP_MIN_GUEST_UPTIME_MS`, `IMP_DEFAULT_VCPUS`,
`IMP_DEFAULT_MEMORY_MIB`, `IMP_DEFAULT_DISK_GIB`, `IMP_DISK_RESERVE_GIB`, `IMP_WATCHDOG_TIMEOUT_S`,
`IMP_WATCHDOG_ACTION`, `IMP_TAILSCALE_HOSTNAME`, `IMP_TAILNET_IDENTITIES`, `IMP_TAILNET_NAMES`,
`IMP_TAILNET_NAME_PREFIX`, `IMP_BUILD_CONTEXT_MAX_MIB`, `IMP_BROKER_PORT`, `IMP_KSM`,
`IMP_KSM_HEADROOM_PERCENT`, `IMP_SSH_AUTHORIZED_KEYS`, `IMP_STORAGE_BACKEND`, `IMP_ZFS_ROOT` and
`IMP_SUBNET6` to impd, the `IMP_BACKUP_*` variables, and the HTTPS settings except the token:
`IMP_DOMAIN`, `IMP_DNS_PROVIDER`, `IMP_DNS_API_URL`, `IMP_ACME_DIRECTORY`, `IMP_ACME_EMAIL`,
`IMP_HTTPS_PORT`, `IMP_HTTP_PORT`, `IMP_PUBLIC_IP`, `IMP_PUBLIC_HTTPS_PORT`, `IMP_PUBLIC_HTTP_PORT`,
and `IMP_ACME_CA_FILE` as a path under the repo. `IMP_E2E=1` lets impd use the `challtestsrv` DNS
provider. With `IMP_TAILNET_NAMES=1`, `dev.sh` writes the OAuth client from 1Password into the data
directory and sets `IMP_TAILNET_OAUTH_FILE`. `IMP_DEV_NETWORK` puts the container on that Docker
network. `IMP_DEV_BACKUP_ENV_FILE` names a Docker env file with the repository's `AWS_*` keys, so
the keys in your own shell never reach the container. Other impd variables keep their defaults in
the dev container. A ZFS dev instance needs the zfs module on the machine;
`scripts/zfs-host-test.sh` runs one on a throwaway pool.

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
imp ls --all                                      # the imps on every saved host
imp new web --place                               # on the saved host with the most free RAM
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
`--host` or `IMP_HOST` names. An empty variable counts as unset. `imp ls --all` and
`imp new --place` call every saved host, each with its own token, and ignore this list
([more than one host](./hosts.md)).

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
`IMP_DATA`, `IMP_ID`, `IMP_CI_KERNEL`, `IMP_SMOKE_IMAGE`, `IMP_BASE_IMAGE` and `IMP_E2E_*`.
`IMP_HOST_IMAGE`, `IMP_HOST_ENV_FILE` and `IMP_HOST_DATA` pick the image, the env file and the data
directory for `deploy/`. `IMP_HOST_FIREWALL` (`own` or `none`) records who owns the host's inbound
firewall; `deploy/bootstrap.sh` reads it, and impd ignores it
([host contract](../architecture/host-contract.md#firewall)). `IMP_HOST_IPV6` (`on` or `off`),
`IMP_HOST_SUBNET6` and `IMP_HOST_NETWORK` put `imp-host` on a Docker network with IPv6; the unit and
`bootstrap.sh` read them, and impd ignores them ([IPv6](./install.md#ipv6)). `IMP_VERSION` and
`IMP_RELEASE_IMAGE` name the image `host/build-release.sh` builds. `KVER` and `KSHA256` pick the
kernel source for `kernel/build.sh` ([kernel README](../../kernel/README.md)).
