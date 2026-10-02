# shellcheck shell=bash
# Shared helpers for scripts/*.sh. Source it; do not run it.

IMP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMP_HOST_IMAGE=${IMP_HOST_IMAGE:-imp-host:dev}
IMP_BUILD=${IMP_BUILD:-$IMP_ROOT/build}

# ensure_host_image builds the host container image unless it exists.
ensure_host_image() {
  if ! docker image inspect "$IMP_HOST_IMAGE" >/dev/null 2>&1; then
    docker build -q -t "$IMP_HOST_IMAGE" --target dev -f "$IMP_ROOT/host/Dockerfile" "$IMP_ROOT" >/dev/null
  fi
}

# load_tailscale_authkey exports TAILSCALE_AUTHKEY from the first source that
# has one and returns 1 when none does: the env var; then a 1Password read of
# IMP_TAILSCALE_AUTHKEY_REF (default op://cloud/imp-tailscale-authkey/credential)
# when op is on PATH; then TAILSCALE_AUTHKEY in the repo's .env. A failed op
# read is quiet and exports IMP_TAILSCALE_OP_MISSED=1, so the rest of the run
# skips op. Tracing stays off in here, so `bash -x` never shows the key.
load_tailscale_authkey() {
  { local xtrace=$-; set +x; } 2>/dev/null
  local key=${TAILSCALE_AUTHKEY:-} found=1
  if [ -z "$key" ] && [ -z "${IMP_TAILSCALE_OP_MISSED:-}" ] && command -v op >/dev/null 2>&1; then
    # stdin closed and a deadline: a locked desktop app must not hang a run
    key=$(timeout 20 op read "${IMP_TAILSCALE_AUTHKEY_REF:-op://cloud/imp-tailscale-authkey/credential}" \
      </dev/null 2>/dev/null) || key=
    [ -n "$key" ] || export IMP_TAILSCALE_OP_MISSED=1
  fi
  if [ -z "$key" ] && [ -f "$IMP_ROOT/.env" ]; then
    key=$(sed -n 's/^TAILSCALE_AUTHKEY=//p' "$IMP_ROOT/.env" | tail -1)
    key=${key#[\"\']}
    key=${key%[\"\']}
  fi
  if [ -n "$key" ]; then
    export TAILSCALE_AUTHKEY=$key
    found=0
  fi
  if [[ $xtrace == *x* ]]; then set -x; fi
  return "$found"
}
