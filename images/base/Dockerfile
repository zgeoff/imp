# imp base image: Ubuntu 24.04 with the Docker engine, supervised by imp-agent.
# The agent itself comes from the imp system drive, not from this image.
# Pinned to the multi-arch index digest, so the published imp-base has a fixed
# base. Bumping it is a dependency change: review it like one.
FROM ubuntu:24.04@sha256:a853f94d226358a79c740cfc7bce0c289748f3fe3488d921d038ccd752c61b60

# Docker's packages, at apt's exact versions. A bump is a reviewed dependency
# change: update these versions, the licence tags they imply and the licence
# sums below together. host/check-base-image.sh checks the image against them.
ARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble
ARG DOCKER_CE_CLI_VERSION=5:29.8.2-1~ubuntu.24.04~noble
ARG CONTAINERD_VERSION=2.3.6-1~ubuntu.24.04~noble
ARG BUILDX_VERSION=0.37.1-1~ubuntu.24.04~noble

# sha256 of Docker's apt signing key (fingerprint 9DC8 5822 9FC7 DD38 854A
# E2D8 8D81 803C 0EBF CD88), the key apt trusts for the packages above
ARG DOCKER_APT_GPG_SHA256=1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570

ARG DEBIAN_FRONTEND=noninteractive

# git stays: coding agents clone and commit, and it costs about 20 MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl iproute2 iptables procps sudo less vim-tiny \
      openssh-client git \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "$DOCKER_APT_GPG_SHA256  /etc/apt/keyrings/docker.asc" | sha256sum -c - \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "docker-ce=$DOCKER_CE_VERSION" "docker-ce-cli=$DOCKER_CE_CLI_VERSION" \
      "containerd.io=$CONTAINERD_VERSION" "docker-buildx-plugin=$BUILDX_VERSION" \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log \
      /var/log/alternatives.log /var/cache/debconf/*-old /var/lib/dpkg/*-old

# Docker's packages ship no copyright file, so copy the upstream LICENSE and
# NOTICE from the source tag of each installed version. The sums pin the
# text: a version bump that changes a file fails here and names the new sum,
# for the reviewer to read the text and update the sum.
RUN set -eu; \
    notice() { \
      version=$(dpkg-query -W -f '${Version}' "$1" | sed 's/^[0-9]*://; s/-.*//'); \
      url="https://raw.githubusercontent.com/$2/$3$version/$4"; \
      dest="/usr/share/doc/$1/$4"; \
      mkdir -p "/usr/share/doc/$1"; \
      curl -fsSL "$url" -o "$dest"; \
      if ! echo "$5  $dest" | sha256sum -c --status; then \
        echo "$url changed upstream: review it, then pin $(sha256sum "$dest" | cut -d' ' -f1)" >&2; \
        exit 1; \
      fi; \
    }; \
    notice docker-ce moby/moby docker-v LICENSE 7c87873291f289713ac5df48b1f2010eb6963752bbd6b530416ab99fc37914a8; \
    notice docker-ce moby/moby docker-v NOTICE a249c4197359eee43031d16cecb172326f92ee7b6701af99dfe5c3e5b3d5eca9; \
    notice docker-ce-cli docker/cli v LICENSE 2d81ea060825006fc8f3fe28aa5dc0ffeb80faf325b612c955229157b8c10dc0; \
    notice docker-ce-cli docker/cli v NOTICE a8c869fbda819afb8d80e0ac19bac52e766bc6c19cb38cf94f52d64c4be2aab6; \
    notice docker-buildx-plugin docker/buildx v LICENSE cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30

COPY rootfs/ /
