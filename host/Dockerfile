# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# imp host container: impd, Firecracker and tailscaled.
# Run with --privileged --device /dev/kvm and its own network namespace.
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

# --- runtime: what every host container needs, dev or release ---
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS runtime

ARG FIRECRACKER_VERSION=v1.17.0
# sha256 of firecracker-${FIRECRACKER_VERSION}-x86_64.tgz, as in the release's .sha256.txt
ARG FIRECRACKER_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
ARG DEBIAN_FRONTEND=noninteractive

# zfsutils-linux is in contrib. Only the userland: the module comes from the
# host kernel through /dev/zfs, and impd refuses a different major version.
RUN sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xfsprogs e2fsprogs squashfs-tools zfsutils-linux \
      iproute2 iptables procps util-linux kmod jq \
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

COPY host/scripts/ /usr/local/lib/imp/
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
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
      > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends squashfs-tools \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY agent/ ./
# -buildvcs=false and -trimpath keep git state and paths out of the binaries.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    for cmd in imp-agent imp-agentctl; do \
      CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' -o "/out/$cmd" "./cmd/$cmd" || exit 1; \
    done

# The drive is mounted read-only as the initial root, so stage 1's
# mountpoints must exist in it. Fixed times and one processor make the drive
# the same bytes for the same agent, so an upgrade that leaves the agent
# alone keeps every snapshot valid.
RUN d=$(mktemp -d) && chmod 755 "$d" \
 && mkdir -p "$d/dev" "$d/proc" "$d/sys" "$d/newroot" \
 && cp /out/imp-agent "$d/imp-agent" \
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
COPY packages/ packages/
# --ignore-scripts: the root prepare script installs git hooks. No
# --production: the CLI builds @zgeoff/imp-client from source, and the client
# bundles @imp/api for npm, so it lists it only as a devDependency. The
# binaries carry only what they import, so dev dependencies never ship.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# No --target: the image's own bun (linux x64, glibc) becomes the runtime,
# which matches the debian runtime stage and needs no download.
RUN bun build --compile packages/daemon/src/main.ts --outfile /out/impd \
 && bun build --compile packages/cli/src/main.ts --outfile /out/imp

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
# the CLI in the container finds impd's token with no IMP_TOKEN
RUN mkdir -p /root/.config/imp && ln -s /var/lib/imp/token /root/.config/imp/token

# IMP_STORAGE_LOOP=0: /var/lib/imp must be a host XFS mount. A loop file in
# the container layer would vanish, with every imp, when the container goes.
ENV IMP_DAEMON=/usr/local/bin/impd \
    IMP_KERNEL=/usr/local/share/imp/vmlinux \
    IMP_SYSTEM_DRIVE=/usr/local/share/imp/imp-system.squashfs \
    IMP_STORAGE_LOOP=0
