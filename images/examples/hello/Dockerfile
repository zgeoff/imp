# Bring-your-own image example: images/base plus one HTTP service on :8080,
# started by imp-agent from /etc/imp/services.d/hello.json.
#   docker build -t imp/hello images/examples/hello
# The published images/base, pinned by digest. A bump to a newer base is a
# reviewed change; check it with gh attestation verify (docs/guides/images.md).
FROM ghcr.io/zgeoff/imp-base:0.29.0@sha256:1851f631ea77f3a99b6f1f9af8ca8868434f4cd066158bcf9def8678c29b0c21

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends busybox-static \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log

COPY rootfs/ /
