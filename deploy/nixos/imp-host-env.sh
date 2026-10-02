#!/bin/bash
# imp-host-env.sh BOOTSTRAP_SH: write /etc/imp/imp-host.env for the NixOS
# module (deploy/nixos/module.nix), which runs it before each start of
# imp-host. The module's settings come from the Nix store, so they hold no
# secret; the secrets come from a file outside it, read here and written
# only to the env file (0600). The Tailscale key never comes here: the
# module mounts its file into the container.
#
# It sources deploy/bootstrap.sh for the RAM budget, so both installers size
# a host the same way.
#
# Input, from the environment:
#   IMP_SETTINGS   the module's settings, KEY=value lines
#   IMP_STORAGE    xfs or zfs
#   IMP_RAM_BUDGET MiB, or empty for bootstrap.sh's formula
#   IMP_ARC_MAX    the ZFS ARC cap in MiB (zfs only), which the budget leaves
#                  out; empty: keep a cap already set, else bootstrap.sh's
#   IMP_SECRETS    an env file of secrets, or empty
#   IMP_ENV_OUT    where to write (default /etc/imp/imp-host.env)
#   IMP_MEMINFO    default /proc/meminfo
#   IMP_ARC_PARAM  default /sys/module/zfs/parameters/zfs_arc_max
set -euo pipefail

# shellcheck source=deploy/bootstrap.sh
. "${1:?usage: imp-host-env.sh BOOTSTRAP_SH}"

out=${IMP_ENV_OUT:-/etc/imp/imp-host.env}
meminfo=${IMP_MEMINFO:-/proc/meminfo}

arc_param=${IMP_ARC_PARAM:-/sys/module/zfs/parameters/zfs_arc_max}

memtotal=$(awk '/^MemTotal:/ { print $2 }' "$meminfo")
arc=0
if [ "$IMP_STORAGE" = zfs ]; then
  live=$(cat "$arc_param" 2>/dev/null || echo 0)
  if [ -n "${IMP_ARC_MAX:-}" ]; then
    # boot.extraModprobeConfig sets it at boot; this covers a module loaded before.
    arc=$IMP_ARC_MAX
  elif [ "$live" != 0 ]; then
    arc=$((live / 1024 / 1024))
    echo "imp-host-env: keeping the ZFS ARC cap already set, $arc MiB"
  else
    arc=$(zfs_arc_max_mib "$memtotal")
  fi
  if [ "$live" != $((arc * 1024 * 1024)) ] && [ -w "$arc_param" ]; then
    echo $((arc * 1024 * 1024)) >"$arc_param"
  fi
fi
if [ -n "${IMP_RAM_BUDGET:-}" ]; then
  budget=$IMP_RAM_BUDGET
else
  budget=$(ram_budget_mib "$memtotal" "$arc")
  check_ram_budget "$budget" "$memtotal" "$arc" "services.imp.ramBudgetMiB" || {
    echo "imp-host-env: refusing to start imp-host" >&2
    exit 1
  }
fi
echo "imp-host-env: RAM $((memtotal / 1024)) MiB, ZFS ARC cap $arc MiB, budget for awake imps $budget MiB"

secrets=""
if [ -n "${IMP_SECRETS:-}" ]; then
  [ -r "$IMP_SECRETS" ] || {
    echo "imp-host-env: cannot read $IMP_SECRETS" >&2
    exit 1
  }
  secrets=$(cat "$IMP_SECRETS")
fi

# Later lines win in docker --env-file, so the secrets file can set any key
# but the budget, which comes last.
content=$(
  echo "# Written by imp-host-env.sh (the NixOS module) at each start; edits are lost."
  cat "$IMP_SETTINGS"
  [ -z "$secrets" ] || printf '%s\n' "$secrets"
  echo "IMP_RAM_BUDGET_MIB=$budget"
)
write_file "$out" 600 "$content"
