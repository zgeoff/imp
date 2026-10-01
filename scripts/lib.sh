# shellcheck shell=bash
# Shared helpers for scripts/*.sh. Source it; do not run it.

IMP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMP_HOST_IMAGE=${IMP_HOST_IMAGE:-imp-host:dev}
IMP_BUILD=${IMP_BUILD:-$IMP_ROOT/build}

# ensure_host_image builds the host container image unless it exists.
ensure_host_image() {
  if ! docker image inspect "$IMP_HOST_IMAGE" >/dev/null 2>&1; then
    docker build -q -t "$IMP_HOST_IMAGE" "$IMP_ROOT/host" >/dev/null
  fi
}
