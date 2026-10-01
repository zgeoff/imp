# imp base image: Ubuntu 24.04 with the Docker engine, supervised by imp-agent.
# The agent itself comes from the imp system drive, not from this image.
FROM ubuntu:24.04

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
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log

COPY rootfs/ /
