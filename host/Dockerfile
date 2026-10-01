# imp host container: impd, Firecracker and tailscaled.
# Run with --privileged --device /dev/kvm and its own network namespace.
#
# Every input is pinned by version and digest, so a rebuild gets the same
# bits. To bump one, change the version and its digest together. Bun matches
# packageManager in package.json.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG FIRECRACKER_VERSION=v1.17.0
# sha256 of firecracker-${FIRECRACKER_VERSION}-x86_64.tgz, as in the release's .sha256.txt
ARG FIRECRACKER_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xfsprogs e2fsprogs squashfs-tools \
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

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY scripts/ /usr/local/lib/imp/
COPY entrypoint /usr/local/bin/imp-entrypoint

EXPOSE 7070 7080
# CMD, not ENTRYPOINT: the build scripts run their own commands in this image.
CMD ["/usr/local/bin/imp-entrypoint"]
