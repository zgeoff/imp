# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# imp host container: impd, Firecracker and tailscaled.
# Run with the privileges of deploy/imp-host.args.json, not --privileged
# (docs/architecture/host-contract.md#privileges), and its own network namespace.
#
# Build from the repo root (.dockerignore keeps outputs and data out):
#
#   docker build -f host/Dockerfile --target dev .   runtime + bun; impd runs
#                                                    from the repo at /src
#   host/build-release.sh                            the release image: impd,
#                                                    the CLI, the guest kernel
#                                                    and the system drive baked in
#
# Every input is pinned by version and digest, so a rebuild gets the same
# bits. To bump one, change the version and its digest together. Bun matches
# packageManager in package.json.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

# --- ksm-exec: starts Firecracker so KSM may merge its guest memory, when
# IMP_KSM is on (docs/architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages) ---
FROM golang:1.26.8-trixie@sha256:eae2aaa6add2936cbf350dd0d2628b363461542f0c4b3c0b558957e0f2997379 AS ksm-exec
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY agent/cmd/ksm-exec/ ./cmd/ksm-exec/
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/ksm-exec ./cmd/ksm-exec

# --- runtime: what every host container needs, dev or release ---
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS runtime

ARG FIRECRACKER_VERSION=v1.17.0
# sha256 of firecracker-${FIRECRACKER_VERSION}-x86_64.tgz, as in the release's .sha256.txt
ARG FIRECRACKER_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
ARG DEBIAN_FRONTEND=noninteractive
# off-host backups (docs/architecture/backups.md); sha256 of
# restic_${RESTIC_VERSION}_linux_amd64.bz2, as in the release's SHA256SUMS
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_SHA256=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xfsprogs e2fsprogs squashfs-tools \
      iproute2 iptables nftables conntrack procps util-linux kmod jq bzip2 \
 && rm -rf /var/lib/apt/lists/*

# The zfs userland, 2.4 from trixie-backports (contrib), to match the module
# Ubuntu 26.04 hosts ship; trixie itself has 2.3. Backports drop a version
# once a newer one lands, so it comes from a dated snapshot, pinned. Only the
# userland: the module comes from the host kernel through /dev/zfs, and impd
# refuses a different major version (docs/architecture/storage.md#versions).
# check-valid-until=no: a snapshot's Release file expires after a week.
ARG ZFS_SNAPSHOT=20261001T000000Z
ARG ZFS_VERSION=2.4.4-1~bpo13+1
RUN echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${ZFS_SNAPSHOT} trixie-backports contrib" \
      > /etc/apt/sources.list.d/zfs-backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t trixie-backports "zfsutils-linux=${ZFS_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI and Tailscale from their upstream apt repos.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
      > /etc/apt/sources.list.d/docker.list \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli tailscale \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/firecracker.tgz "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-x86_64.tgz" \
 && echo "${FIRECRACKER_SHA256}  /tmp/firecracker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/firecracker.tgz -C /tmp \
 && install -m 0755 "/tmp/release-${FIRECRACKER_VERSION}-x86_64/firecracker-${FIRECRACKER_VERSION}-x86_64" /usr/local/bin/firecracker \
 && install -m 0755 "/tmp/release-${FIRECRACKER_VERSION}-x86_64/jailer-${FIRECRACKER_VERSION}-x86_64" /usr/local/bin/jailer \
 && rm -rf /tmp/release-* /tmp/firecracker.tgz

COPY --from=ksm-exec /out/ksm-exec /usr/local/bin/ksm-exec

RUN curl -fsSL -o /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2" \
 && echo "${RESTIC_SHA256}  /tmp/restic.bz2" | sha256sum -c - \
 && bunzip2 -c /tmp/restic.bz2 >/usr/local/bin/restic \
 && chmod 0755 /usr/local/bin/restic \
 && rm /tmp/restic.bz2

COPY host/scripts/ /usr/local/lib/imp/
# tailscale-up.sh starts tailscaled from saved node state with no key, so
# deploy/bootstrap.sh may blank a spent key in the env file.
LABEL imp.tailscale-keyless="1"
# Runs without --privileged under deploy/imp-host.service's privileges;
# deploy/upgrade.sh refuses an image without this once the unit drops it.
LABEL imp.host-contract="unprivileged"
COPY host/entrypoint /usr/local/bin/imp-entrypoint

EXPOSE 7070 7080
# CMD, not ENTRYPOINT: the build scripts run their own commands in this image.
CMD ["/usr/local/bin/imp-entrypoint"]

# --- dev: impd runs from the repo mounted at /src (scripts/dev.sh) ---
FROM runtime AS dev
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# --- kernel-builder: the guest kernel toolchain (kernel/build.sh uses it too) ---
# Ubuntu 22.04 gives gcc 11, the same compiler as Firecracker's CI config. The
# apt sources point at a dated snapshot, so the toolchain stays the same
# until UBUNTU_SNAPSHOT changes, and so does the kernel it builds.
FROM ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02 AS kernel-builder

ARG UBUNTU_SNAPSHOT=20261001T000000Z
ARG DEBIAN_FRONTEND=noninteractive

# The snapshot is served over https only, so ca-certificates comes from the
# live archive first; it holds CA roots, nothing that reaches the kernel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && printf 'deb https://snapshot.ubuntu.com/ubuntu/%s jammy%s main universe\n' \
      "$UBUNTU_SNAPSHOT" "" "$UBUNTU_SNAPSHOT" -updates "$UBUNTU_SNAPSHOT" -security \
      > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential bc bison flex libelf-dev libssl-dev python3 cpio kmod xz-utils curl \
 && rm -rf /var/lib/apt/lists/*

# --- kernel: vmlinux from kernel/version and the config files only, so a
# change anywhere else never reruns the long build. The paths match
# kernel/build.sh (kernel/ at /k), so both builds give the same vmlinux. ---
FROM kernel-builder AS kernel
WORKDIR /k
COPY kernel/version ./
RUN . ./version \
 && mkdir .build \
 && curl -fsSL --retry 3 -o linux.tar.xz "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KVER}.tar.xz" \
 && echo "${KSHA256}  linux.tar.xz" | sha256sum -c - \
 && tar -xf linux.tar.xz -C .build \
 && rm linux.tar.xz
COPY kernel/config-base kernel/docker.fragment kernel/make-vmlinux.sh ./
# Empty JOBS means every core; host/check-reproducible.sh varies it.
ARG JOBS=
RUN . ./version \
 && ./make-vmlinux.sh "/k/.build/linux-${KVER}" /k/.build/obj /k/out \
 && rm -rf /k/.build

# --- agent: the static guest agent, imp-agentctl, and the system drive that
# holds the agent. scripts/build-system-drive.sh builds the same stage for
# the dev instance. ---
FROM golang:1.26.8-trixie@sha256:eae2aaa6add2936cbf350dd0d2628b363461542f0c4b3c0b558957e0f2997379 AS agent

ARG DEBIAN_SNAPSHOT=20261001T000000Z
ARG DEBIAN_FRONTEND=noninteractive
# mksquashfs from a dated snapshot: the drive's bytes depend on its version.
# check-valid-until=no: a snapshot's Release file expires after a week.
# musl-tools and bzip2 from there too: they build busybox, with the
# image's gcc, pinned by its digest.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
      > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends squashfs-tools musl-tools bzip2 \
 && rm -rf /var/lib/apt/lists/*

# busybox, static on musl, for `imp exec --agent` (host/busybox.config). musl
# has no kernel headers of its own, so it borrows the system's. A fixed
# SOURCE_DATE_EPOCH and no config timestamp keep the build date out of the
# binary. Before the agent's sources, so a change to them never rebuilds it;
# a new Go image does, with its gcc, and changes the binary's bytes.
ARG BUSYBOX_VERSION=1.37.0
ARG BUSYBOX_SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
COPY host/busybox.config /tmp/busybox.config
ARG JOBS=
RUN m=/usr/include/x86_64-linux-musl \
 && ln -s /usr/include/linux /usr/include/asm-generic /usr/include/mtd "$m/" \
 && ln -s /usr/include/x86_64-linux-gnu/asm "$m/asm" \
 && curl -fsSL --retry 3 -o /tmp/busybox.tar.bz2 "https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2" \
 && echo "${BUSYBOX_SHA256}  /tmp/busybox.tar.bz2" | sha256sum -c - \
 && tar -xjf /tmp/busybox.tar.bz2 -C /tmp \
 && cd "/tmp/busybox-${BUSYBOX_VERSION}" \
 && cp /tmp/busybox.config .config \
 && SOURCE_DATE_EPOCH=0 KCONFIG_NOTIMESTAMP=1 make CC=musl-gcc -j"${JOBS:-$(nproc)}" busybox \
 && mkdir -p /out/busybox \
 && install -m 0755 busybox /out/busybox/busybox \
 && ./busybox --list >/out/busybox/applets \
 && cd / && rm -rf /tmp/busybox*

WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY agent/ ./
# -buildvcs=false and -trimpath keep git state and paths out of the binaries.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    for cmd in imp-agent imp-agentctl; do \
      CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' -o "/out/$cmd" "./cmd/$cmd" || exit 1; \
    done

# The drive is mounted read-only as the root of the agent's world, so its
# mountpoints must exist in it: /user takes the user disk. /bin holds
# busybox and a link per applet. Fixed times and one processor make the drive
# the same bytes for the same agent, so an upgrade that leaves the agent
# alone keeps every snapshot valid.
RUN d=$(mktemp -d) && chmod 755 "$d" \
 && mkdir -p "$d/dev" "$d/proc" "$d/sys" "$d/run" "$d/user" "$d/bin" \
 && cp /out/imp-agent "$d/imp-agent" \
 && cp /out/busybox/busybox "$d/bin/busybox" \
 && while read -r applet; do [ "$applet" = busybox ] || ln -s busybox "$d/bin/$applet"; done </out/busybox/applets \
 && rm -rf /out/busybox \
 && mksquashfs "$d" /out/imp-system.squashfs -all-root -noappend -quiet -no-progress -comp zstd \
      -no-xattrs -mkfs-time 0 -all-time 0 -processors 1 \
 && rm -rf "$d"

# --- system-drive: the agent binaries and the drive, for `--output`
# (scripts/build-system-drive.sh) ---
FROM scratch AS system-drive
COPY --from=agent /out/ /

# --- system-files: the guest kernel and the system drive, for `--output`
# (host/check-reproducible.sh, release assets) and the release image ---
FROM scratch AS system-files
COPY --from=kernel /k/out/vmlinux /
COPY --from=agent /out/imp-system.squashfs /

# --- compile: impd and the imp CLI as standalone binaries ---
FROM bun AS compile
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
# patchedDependencies: bun install applies these
COPY patches/ patches/
COPY packages/ packages/
# --ignore-scripts: the root prepare script installs git hooks. No
# --production: the CLI builds @zgeoff/imp-client from source, and the client
# bundles @imp/api for npm, so it lists it only as a devDependency. The
# binaries carry only what they import, so dev dependencies never ship.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# No --target: the image's own bun (linux x64, glibc) becomes the runtime,
# which matches the debian runtime stage and needs no download.
# --external cpu-features: ssh2 loads this optional native module in a
# try/catch, and --ignore-scripts leaves its .node file unbuilt.
RUN bun build --compile --external cpu-features packages/daemon/src/main.ts --outfile /out/impd \
 && bun build --compile packages/cli/src/main.ts --outfile /out/imp

# --- dashboard: the web dashboard's static files. Its own stage: the build
# needs the dev dependencies (vite) that the compile stage leaves out. ---
FROM bun AS dashboard
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY patches/ patches/
COPY packages/ packages/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
RUN bun run --cwd packages/dashboard build

# --- release: the runtime with everything baked in; nothing from the repo
# is mounted. The default target. impd reports its package.json version;
# IMP_VERSION only labels the image (host/build-release.sh sets it). ---
FROM runtime AS release

ARG IMP_VERSION=unknown
LABEL org.opencontainers.image.title="imp-host" \
      org.opencontainers.image.description="imp host: impd, Firecracker and tailscaled" \
      org.opencontainers.image.source="https://github.com/zgeoff/imp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${IMP_VERSION}"

COPY --from=system-files / /usr/local/share/imp/
COPY --from=compile /out/impd /out/imp /usr/local/bin/
COPY --from=dashboard /src/packages/dashboard/dist /usr/local/share/imp/dashboard
# deploy/bootstrap.sh and deploy/upgrade.sh install the unit and seccomp
# profile of the image they run
COPY deploy/imp-host.service deploy/imp-host.seccomp.json /usr/local/share/imp/deploy/
# the CLI in the container finds impd's token with no IMP_TOKEN
RUN mkdir -p /root/.config/imp && ln -s /var/lib/imp/token /root/.config/imp/token

# IMP_STORAGE_LOOP=0: /var/lib/imp must be a host XFS mount. A loop file in
# the container layer would vanish, with every imp, when the container goes.
ENV IMP_DAEMON=/usr/local/bin/impd \
    IMP_KERNEL=/usr/local/share/imp/vmlinux \
    IMP_SYSTEM_DRIVE=/usr/local/share/imp/imp-system.squashfs \
    IMP_DASHBOARD_DIR=/usr/local/share/imp/dashboard \
    IMP_STORAGE_LOOP=0
