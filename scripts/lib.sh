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

# read_tailscale_authkey prints the Tailscale auth key, or nothing: the
# TAILSCALE_AUTHKEY env var, else a 1Password read of IMP_TAILSCALE_AUTHKEY_REF
# (default op://cloud/imp-tailscale-authkey/credential) when op is on PATH,
# else TAILSCALE_AUTHKEY from the repo's .env. A failed or slow op read falls
# through quietly. Capture the output; never echo it.
read_tailscale_authkey() {
  if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
    printf '%s' "$TAILSCALE_AUTHKEY"
    return 0
  fi
  local key=
  if command -v op >/dev/null 2>&1; then
    # stdin closed and a deadline: a locked desktop app must not hang a run
    key=$(timeout 20 op read "${IMP_TAILSCALE_AUTHKEY_REF:-op://cloud/imp-tailscale-authkey/credential}" \
      </dev/null 2>/dev/null) || key=
  fi
  if [ -z "$key" ] && [ -f "$IMP_ROOT/.env" ]; then
    key=$(sed -n 's/^TAILSCALE_AUTHKEY=//p' "$IMP_ROOT/.env" | tail -1)
    key=${key#[\"\']}
    key=${key%[\"\']}
  fi
  printf '%s' "$key"
}
