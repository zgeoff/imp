# shellcheck shell=bash
# Take a fresh Ubuntu 24.04 or 26.04, or Debian 13, server to a running imp host
# (docs/guides/install.md#bootstrap-a-server). Run as root:
#
#   bootstrap.sh --yes --data-device /dev/nvme1n1
#   bootstrap.sh --yes --loop-file /srv/imp.xfs                # sized from the free space
#   bootstrap.sh --check --data-device /dev/nvme1n1   # exit 2 if a run would change anything
#   bootstrap.sh --yes --storage zfs --data-device /dev/nvme1n1
#
# Phases, in order: preflight, packages, storage, kernel, firewall, ipv6,
# imp, health. Each phase compares the host with what it wants and changes only
# the difference, so a second run changes nothing. --dry-run prints the
# changes instead of making them.
#
# The script is self-contained, so it runs on a server without a checkout:
# bun run render:deploy (scripts/render/render-imp-host.ts) writes it from the parts
# in deploy/bootstrap/, in the order BOOTSTRAP_PARTS there lists, with
# deploy/lib/host-env.sh and the deploy files it installs:
# deploy/imp-host.service, deploy/imp-docker-proxy.service and
# deploy/imp-host.env.example.
#
# The Tailscale key comes from --tailscale-authkey-file or TAILSCALE_AUTHKEY
# and goes only to /etc/imp/imp-host.env (0600). It is never printed and
# never put in argv. Never run this script with `bash -x`.
set -euo pipefail

readonly IMP_DIR=/etc/imp
readonly ENV_FILE=$IMP_DIR/imp-host.env
readonly FIREWALL_FILE=$IMP_DIR/firewall.nft
readonly SECCOMP_FILE=$IMP_DIR/imp-host.seccomp.json
readonly SECCOMP_IN_IMAGE=/usr/local/share/imp/deploy/imp-host.seccomp.json
readonly DATA_DIR=/var/lib/imp
# The image of this script's release, as the units name it; release-please
# bumps it.
readonly DEFAULT_IMAGE=ghcr.io/zgeoff/imp-host:1.0.3 # x-release-please-version
# The image line every env file had before the units named their release.
# A file still holding it gets the commented pin; any other value is the
# operator's pin and stays.
readonly LEGACY_IMAGE_LINE=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest
# Docker's apt signing key (https://docs.docker.com/engine/install/ubuntu/).
readonly DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# The template's IMP_RAM_BUDGET_MIB; a file still holding it gets the
# computed budget, any other value is the operator's and stays.
readonly TEMPLATE_BUDGET_MIB=16384
# A loop file smaller than this is refused.
readonly LOOP_MIN_GIB=20
# apt's output goes here, shown only on failure.
readonly APT_LOG=/var/log/imp-bootstrap-apt.log
# accept_ra=2 for the uplink, when the kernel takes its router adverts.
readonly RA_FILE=/etc/sysctl.d/90-imp-ipv6.conf

mode=
storage=
zfs_pool=
zfs_root=
data_device=
loop_file=
loop_size_gib=auto
image=$DEFAULT_IMAGE
image_set=
image_archive=
authkey=${TAILSCALE_AUTHKEY:-}
authkey_file=
extra_ssh_ports=()
host_firewall=
host_firewall_set=
ipv6=
ipv6_set=
ipv6_auto=
ipv6_subnet=
ra_handled=
skip_health=
ksm=
changes=0
in_container=

# --- output and change tracking ---

log() { echo "bootstrap: $*"; }
warn() { echo "bootstrap: WARNING: $*" >&2; }
die() {
  echo "bootstrap: $*" >&2
  exit 1
}
phase() { echo "== $*"; }

dry() { [ "$mode" != yes ]; }

# change DESCRIPTION CMD...: count a change, then run CMD (with --yes) or
# print the description only. DESCRIPTION must never hold a secret.
change() {
  local what=$1
  shift
  changes=$((changes + 1))
  if dry; then
    log "would: $what"
    return 0
  fi
  log "change: $what"
  # Explicit: a caller on the left of && (put_file ... && changed=1) runs
  # with set -e off, and a failure must not pass for "nothing changed".
  "$@" || die "failed: $what"
}

# put_file PATH MODE CONTENT: write PATH when its content or mode differs.
# Returns 0 when it changed (or would change), 1 when it was already right.
# CONTENT may be secret: it goes through printf, a builtin, so not to argv.
put_file() {
  local path=$1 perm=$2 content=$3
  if [ -f "$path" ] && [ "$(stat -c %a "$path")" = "$perm" ] \
    && [ "$(cat "$path")" = "$content" ]; then
    return 1
  fi
  change "write $path (mode $perm)" write_file "$path" "$perm" "$content"
}

# version_ge A B: A >= B for dotted versions.
version_ge() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$2" ]
}
