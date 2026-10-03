#!/bin/bash
# Check a built imp base image (images/base) before it is pushed: it is
# linux/amd64, it carries the Docker service, config and licence notices, its
# tools run, and it holds nothing of imp's own beyond that service file. The
# agent comes from the system drive at boot, so a copy in the image would be
# stale.
#
#   host/check-base-image.sh IMAGE
#
# IMAGE must be in the local docker.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 IMAGE" >&2
  exit 2
fi
image=$1

status=0
fail() {
  echo "check-base-image: $*" >&2
  status=1
}

# imp releases are x86_64 only, as are the guest kernel and the system drive
platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
if [ "$platform" != linux/amd64 ]; then
  fail "the platform is $platform, want linux/amd64"
fi

in_image() {
  docker run --rm --network none --entrypoint sh "$image" -c "$1"
}

# Docker's packages ship no copyright file; the Dockerfile adds upstream's
files=(
  /etc/imp/services.d/docker.json
  /etc/docker/daemon.json
  /usr/share/doc/docker-ce/LICENSE
  /usr/share/doc/docker-ce/NOTICE
  /usr/share/doc/docker-ce-cli/LICENSE
  /usr/share/doc/docker-ce-cli/NOTICE
  /usr/share/doc/docker-buildx-plugin/LICENSE
)
for file in "${files[@]}"; do
  in_image "test -f $file" || fail "$file is missing"
done

# the docker CLI prints its version without a daemon
for tool in docker git curl; do
  in_image "$tool --version > /dev/null" || fail "$tool --version fails"
done

agents=$(in_image 'find / -xdev -name "imp-agent*" 2> /dev/null || true')
if [ -n "$agents" ]; then
  fail "the image carries imp-agent: $(paste -sd ' ' <<<"$agents")"
fi

imp_files=$(in_image 'find /etc/imp -mindepth 1 ! -type d 2> /dev/null | sort')
if [ "$imp_files" != /etc/imp/services.d/docker.json ]; then
  fail "/etc/imp holds '$(paste -sd ' ' <<<"$imp_files")', want only /etc/imp/services.d/docker.json"
fi

if [ "$status" = 0 ]; then
  echo "check-base-image: ok ($image)"
fi
exit "$status"
