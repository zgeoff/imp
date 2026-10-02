#!/bin/bash
# imp-host-env.sh BOOTSTRAP_SH: write /etc/imp/imp-host.env for the NixOS
# module (deploy/nixos/module.nix), which runs it before each start of
# imp-host. The module's settings come from the Nix store, so they hold no
# secret; the secrets come from files outside it, read here and written only
# to the env file (0600). The key is never printed and never put in argv.
#
# It sources deploy/bootstrap.sh for the RAM budget and the ZFS ARC cap, so
# both installers size a host the same way.
#
# Input, from the environment:
#   IMP_SETTINGS      the module's settings, KEY=value lines
#   IMP_STORAGE       xfs or zfs
#   IMP_RAM_BUDGET    MiB, or empty for bootstrap.sh's formula
#   IMP_ARC_MAX       MiB, or empty for bootstrap.sh's formula (zfs only)
#   IMP_SECRETS       an env file of secrets, or empty
#   IMP_AUTHKEY_FILE  a Tailscale auth key, or empty
#   IMP_JOINED        the marker imp-host-tailscale.service leaves once the
#                     node is up; the key is left out while it exists
#   IMP_ENV_OUT       where to write (default /etc/imp/imp-host.env)
#   IMP_MEMINFO       default /proc/meminfo
#   IMP_ARC_PARAM     default /sys/module/zfs/parameters/zfs_arc_max
set -euo pipefail

# shellcheck source=deploy/bootstrap.sh
. "${1:?usage: imp-host-env.sh BOOTSTRAP_SH}"

out=${IMP_ENV_OUT:-/etc/imp/imp-host.env}
meminfo=${IMP_MEMINFO:-/proc/meminfo}
arc_param=${IMP_ARC_PARAM:-/sys/module/zfs/parameters/zfs_arc_max}

memtotal=$(awk '/^MemTotal:/ { print $2 }' "$meminfo")
arc=0
if [ "$IMP_STORAGE" = zfs ]; then
  arc=${IMP_ARC_MAX:-$(zfs_arc_max_mib "$memtotal")}
  # The cap applies at once, to an ARC already larger too.
  if [ -w "$arc_param" ]; then
    echo $((arc * 1024 * 1024)) >"$arc_param"
  fi
fi
budget=${IMP_RAM_BUDGET:-$(ram_budget_mib "$memtotal" "$arc")}
echo "imp-host-env: RAM $((memtotal / 1024)) MiB, ZFS ARC cap $arc MiB, budget for awake imps $budget MiB"

key=""
if [ -n "${IMP_AUTHKEY_FILE:-}" ] && [ ! -e "${IMP_JOINED:-/nonexistent}" ]; then
  [ -r "$IMP_AUTHKEY_FILE" ] || {
    echo "imp-host-env: cannot read $IMP_AUTHKEY_FILE" >&2
    exit 1
  }
  key=$(tr -d '[:space:]' <"$IMP_AUTHKEY_FILE")
fi

secrets=""
if [ -n "${IMP_SECRETS:-}" ]; then
  [ -r "$IMP_SECRETS" ] || {
    echo "imp-host-env: cannot read $IMP_SECRETS" >&2
    exit 1
  }
  secrets=$(cat "$IMP_SECRETS")
fi

# Later lines win in docker --env-file, so the secrets file can set any key
# but the budget and the key, which come last.
content=$(
  echo "# Written by imp-host-env.sh (the NixOS module) at each start; edits are lost."
  cat "$IMP_SETTINGS"
  [ -z "$secrets" ] || printf '%s\n' "$secrets"
  echo "IMP_RAM_BUDGET_MIB=$budget"
  printf 'TAILSCALE_AUTHKEY=%s\n' "$key"
)
write_file "$out" 600 "$content"
