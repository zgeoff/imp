# Install

imp runs on one Linux machine, in one host container, in one of two ways:

- **The release image** for a server: impd, the `imp` CLI, the guest kernel and the system drive are
  baked in, and nothing from the repo is mounted. [Run the release image](#run-the-release-image)
  covers it.
- **The dev instance** for working on imp: `scripts/dev.sh` builds the host container and runs impd
  from the repo. The [set up](#set-up) steps below cover it.

A one-command server bootstrap is on the [roadmap](https://github.com/zgeoff/imp/issues/41)
([#9](https://github.com/zgeoff/imp/issues/9)).

## Needs

- `/dev/kvm`: bare metal, or a VM with nested virtualization (WSL2 works).
- Docker. The host container is privileged and mounts the Docker socket.
- [Bun](https://bun.sh) for the CLI, and Go for the guest agent.
- Disk for the sparse XFS file. `IMP_STORAGE_GIB` (default 200) sets its apparent size; it uses only
  what imps write.

## Set up

1. Clone the repo and install the dependencies:

   ```sh
   git clone https://github.com/zgeoff/imp && cd imp
   bun install
   ```

2. Build the guest kernel. The first build takes about 9 minutes; the
   [kernel README](../../kernel/README.md) has the details.

   ```sh
   kernel/build.sh
   ```

3. To put imps on your tailnet, write a tagged auth key to `.env` in the repo root. The
   [Tailscale guide](./tailscale.md) covers the key and the ACL.

   ```sh
   TAILSCALE_AUTHKEY=tskey-auth-…
   ```

4. Start impd. `up` builds the host image and the system drive when they are missing, starts the
   container, and waits until impd reports ready.

   ```sh
   scripts/dev.sh up
   ```

5. Give the CLI the token:

   ```sh
   export IMP_TOKEN=$(scripts/dev.sh token)
   ```

   Or write it to `~/.config/imp/token` once.

6. Check it:

   ```sh
   imp info
   imp new box && imp exec box -- uname -a
   ```

**NOTE:** The guides write `imp` for the CLI. From the repo, `scripts/imp` runs it; link it onto
your `PATH` as `imp`, or use `scripts/imp` in its place.

[Configuration](./configuration.md) lists every variable, and [operations](./operations.md) covers
restarts and day-to-day care.

## What `dev.sh up` does

- Builds the `dev` target of `host/Dockerfile` as the host image, and `build/imp-system.squashfs`
  (the agent's system drive) when it is missing.
- Starts the container with `--privileged --device /dev/kvm`, the Docker socket, and the repo
  mounted at `/src` and at its own path.
- Keeps data in `.data/dev/imp.xfs`, a sparse XFS file that the container loop-mounts on
  `/var/lib/imp`.
- Publishes the API on 7070, the proxy on 7080, and per-imp ports 20000–20063.

## WSL2 notes

- The WSL 6.6 kernel rejects newer `mkfs.xfs` defaults. `setup-storage.sh` passes
  `-i nrext64=0,exchange=0 -n parent=0`.
- WSL's uplink MTU is 1360. `dev.sh` passes it to the container, which clamps guest TCP MSS to
  match.
- If the host runs Tailscale with MagicDNS, the container uses public resolvers instead, because its
  own tailscaled would capture `100.100.100.100`.

## Run the release image

The release image runs the compiled impd from `/usr/local/bin/impd` with the kernel and the system
drive from `/usr/local/share/imp`. `imp info` shows the kernel version and the sha256 of both.

### Build it

```sh
host/build-release.sh          # tags imp-host:<git describe>; IMP_VERSION overrides the version
```

The build is multi-stage: the guest kernel, the agent and its system drive, impd and the CLI each
build in their own stage. The kernel stage reads only `kernel/version`, `kernel/config-base`,
`kernel/docker.fragment` and `kernel/make-vmlinux.sh`, so a change anywhere else reuses the cached
kernel layer. A CI runner without that cache rebuilds the kernel; pass `--cache-from` and
`--cache-to` through `build-release.sh` to keep it.

The kernel toolchain and `mksquashfs` come from dated Ubuntu and Debian snapshots, and the build
stamps and drive times are fixed, so the same sources give the same `vmlinux` and
`imp-system.squashfs` bytes. `kernel/build.sh` and `scripts/build-system-drive.sh` use the same
stages, so the dev instance boots the same bytes as the release image. A snapshot of a sleeping imp
restores only with the kernel and drive it was taken on, so this is what lets an upgrade that leaves
them alone keep every imp's memory. Only these two files are reproducible; the image digest is not
(apt packages, timestamps and the compiled impd differ per build).

`host/check-reproducible.sh` checks it: one cold build, one on a fresh builder, and one after a
change under `packages/`. It takes 5 to 20 minutes; the `Reproducible` workflow runs it in CI by
hand.

### Prepare the host

1. Put `/var/lib/imp` on an XFS filesystem with reflink, a partition of its own:

   ```sh
   mkfs.xfs -m reflink=1 /dev/<partition>
   echo '/dev/<partition> /var/lib/imp xfs defaults 0 2' >> /etc/fstab
   mkdir -p /var/lib/imp && mount /var/lib/imp
   ```

   The release image refuses to start when `/var/lib/imp` is not an XFS mount with reflink. It never
   falls back to a loop file inside the container, which would go away with the container and take
   every imp with it.

2. Write the settings, from [`deploy/imp-host.env.example`](../../deploy/imp-host.env.example):

   ```sh
   install -d /etc/imp
   install -m 0600 deploy/imp-host.env.example /etc/imp/imp-host.env   # then edit it
   ```

   Without `TAILSCALE_AUTHKEY` the host is local-only: the API and the proxy listen on
   `127.0.0.1:7070` and `127.0.0.1:7080`, and no imp is reachable from another machine. With a key,
   the tailnet reaches impd and every imp through the container's own `tailscaled`. Use a
   non-ephemeral tagged key on a server ([Tailscale guide](./tailscale.md)).

### Start it

Use one of the two, not both. Both run the container with `--init --privileged --device /dev/kvm`,
the host's Docker socket and `/var/lib/imp`, and give impd 120 seconds to sleep every imp on stop.

- **systemd:** [`deploy/imp-host.service`](../../deploy/imp-host.service) runs `docker run` in the
  foreground, so systemd supervises it.

  ```sh
  install -m 0644 deploy/imp-host.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now imp-host
  ```

- **Compose:** [`deploy/compose.yaml`](../../deploy/compose.yaml), with a Docker restart policy.
  Needs Docker Compose 2.24 or later, for the `env_file` entry with `path` and `required`.

  ```sh
  docker compose -f deploy/compose.yaml up -d
  ```

  On shutdown, `dockerd` stops the container and systemd waits 90 seconds for `docker.service` by
  default. Give it the 120 seconds impd needs with a drop-in:

  ```ini
  # /etc/systemd/system/docker.service.d/imp-stop.conf
  [Service]
  TimeoutStopSec=150
  ```

The systemd unit needs no drop-in: it stops the container itself before Docker stops.

Then, on the host:

```sh
docker exec imp-host imp info     # the CLI is in the image and finds the token itself
```

### Images on a server

`imp image build <dir>` builds from a directory impd can see, and in the release image the repo is
not there: the build fails with `does not exist on the impd host`. Build the image with the host's
Docker, then add it:

```sh
docker build -t imp-base images/base
imp image add imp-base --name base
```

Until an image named `IMP_DEFAULT_IMAGE` (default `base`) exists, `imp new` uses `ubuntu` and impd
logs a warning at start.
