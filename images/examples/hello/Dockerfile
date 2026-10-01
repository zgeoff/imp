# Bring-your-own image example: images/base plus one HTTP service on :8080,
# started by imp-agent from /etc/imp/services.d/hello.json.
#   docker build -t imp/hello images/examples/hello
ARG BASE=imp/base
FROM ${BASE}

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends busybox-static \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log

COPY rootfs/ /
