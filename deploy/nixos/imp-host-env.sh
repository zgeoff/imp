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
#   IMP_BACKUP_STAGED       the host copy of the backup password, or empty
#   IMP_BACKUP_IN_CONTAINER where the container sees that copy
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

# The backup password is a file the module mounts; without one, backups
# stay off whatever the secrets file says.
backup=()
if [ -n "${IMP_BACKUP_STAGED:-}" ]; then
  if [ -f "$IMP_BACKUP_STAGED" ] && [ -s "$IMP_BACKUP_STAGED" ]; then
    backup=("IMP_BACKUP_PASSWORD_FILE=$IMP_BACKUP_IN_CONTAINER")
  else
    echo "imp-host-env: no backup password; IMP_BACKUP_REPOSITORY is blanked, and backups stay off" >&2
    backup=("IMP_BACKUP_REPOSITORY=")
  fi
fi

# A later line wins, and only it is kept: the secrets file can set any key
# but the backup ones above and the budget.
content=$(
  {
    echo "# Written by imp-host-env.sh (the NixOS module) at each start; edits are lost."
    cat "$IMP_SETTINGS"
    [ -z "$secrets" ] || printf '%s\n' "$secrets"
    [ ${#backup[@]} = 0 ] || printf '%s\n' "${backup[@]}"
    echo "IMP_RAM_BUDGET_MIB=$budget"
  } | awk '
    /^[A-Za-z_][A-Za-z0-9_]*=/ { key = substr($0, 1, index($0, "=") - 1); last[key] = NR }
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (line[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
          key = substr(line[i], 1, index(line[i], "=") - 1)
          if (last[key] != i) continue
        }
        print line[i]
      }
    }'
)
write_file "$out" 600 "$content"
