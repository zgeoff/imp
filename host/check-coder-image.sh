#!/bin/bash
# Check a built imp coder image (images/coder) before it is pushed: it
# proves the image matches images/coder/Dockerfile. It is linux/amd64, it
# runs the Claude Code that the Dockerfile pins, byte for byte, with updates
# off by default, and it keeps the base's tools. The pins come from the
# Dockerfile, so a bump to the version or the sum is a reviewed change
# there, never an edit here.
#
#   host/check-coder-image.sh IMAGE
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
  echo "check-coder-image: $*" >&2
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

dockerfile=$(dirname "$0")/../images/coder/Dockerfile
version=$(sed -n 's/^ARG CLAUDE_CODE_VERSION=//p' "$dockerfile")
sum=$(sed -n 's/^ARG CLAUDE_CODE_SHA256=//p' "$dockerfile")

got=$(in_image 'claude --version' 2> /dev/null || true)
if [ -z "$version" ] || [ "$got" != "$version (Claude Code)" ]; then
  fail "claude --version prints '${got:-nothing}', want '${version:-the ARG CLAUDE_CODE_VERSION in $dockerfile} (Claude Code)'"
fi

got=$(in_image 'sha256sum /usr/local/bin/claude' 2> /dev/null | cut -d' ' -f1 || true)
if [ -z "$sum" ] || [ "$got" != "$sum" ]; then
  fail "/usr/local/bin/claude has sha256 ${got:-unknown}, want ${sum:-the ARG CLAUDE_CODE_SHA256 in $dockerfile}"
fi

# shellcheck disable=SC2016 # the image's shell expands it
if [ "$(in_image 'echo "$DISABLE_UPDATES"')" != 1 ]; then
  fail "DISABLE_UPDATES is not 1, so claude could update itself off the pin"
fi

# what imp and a coding agent need from the base
for tool in sh tar mkdir git curl; do
  in_image "command -v $tool > /dev/null" || fail "$tool is missing"
done

# the binary needs no Node, so the image carries none
if in_image 'command -v node > /dev/null'; then
  fail "the image carries node"
fi

if [ "$status" = 0 ]; then
  echo "check-coder-image: ok ($image)"
fi
exit "$status"
