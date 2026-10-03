# Bring-your-own image example: images/base plus one HTTP service on :8080,
# started by imp-agent from /etc/imp/services.d/hello.json.
#   docker build -t imp/hello images/examples/hello
# The published images/base, pinned by digest. A bump to a newer base is a
# reviewed change; check it with gh attestation verify (docs/guides/images.md).
FROM ghcr.io/zgeoff/imp-base:dryrun-4b3f4fc940b9@sha256:d533c8dd970fe08429e93dd33fe73e7f0e81ec3491454d516278f3129b06b50b

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends busybox-static \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log

COPY rootfs/ /
