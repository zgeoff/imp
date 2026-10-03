# imp base image: Ubuntu 24.04 with the Docker engine, supervised by imp-agent.
# The agent itself comes from the imp system drive, not from this image.
# Pinned to the multi-arch index digest, so the published imp-base has a fixed
# base. Bumping it is a dependency change: review it like one.
FROM ubuntu:24.04@sha256:a853f94d226358a79c740cfc7bce0c289748f3fe3488d921d038ccd752c61b60

ARG DEBIAN_FRONTEND=noninteractive

# git stays: coding agents clone and commit, and it costs about 20 MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl iproute2 iptables procps sudo less vim-tiny \
      openssh-client git \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log \
      /var/log/alternatives.log /var/cache/debconf/*-old /var/lib/dpkg/*-old

COPY rootfs/ /
