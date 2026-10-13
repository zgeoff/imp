# shellcheck shell=bash
# The kernel and ksm phases: sysctls, modules, the ZFS ARC cap and KSM.

ensure_kernel() {
  phase kernel
  local sysctls=$'# Written by deploy/bootstrap.sh.\n# Guests are sized past RAM by design: the governor sleeps imps to keep the\n# awake ones under IMP_RAM_BUDGET_MIB, so large sparse maps must not fail.\nvm.overcommit_memory = 1\n# Keep guest memory in RAM. Swap stays as the installer made it, but the\n# governor measures RAM per VM, and swapped guest pages would hide from it.\nvm.swappiness = 1'
  local mods=(kvm tun loop)
  [ "$storage" = zfs ] && mods+=(zfs)
  put_file /etc/sysctl.d/90-imp.conf 644 "$sysctls" || true
  put_file /etc/modules-load.d/imp.conf 644 \
    "$(echo '# Written by deploy/bootstrap.sh.' && printf '%s\n' "${mods[@]}")" || true
  local arc_bytes=""
  if [ "$storage" = zfs ]; then
    arc_bytes=$(($(zfs_arc_max_mib "$(memtotal_kib)") * 1024 * 1024))
    put_file /etc/modprobe.d/imp-zfs.conf 644 \
      "$(printf '# Written by deploy/bootstrap.sh: the ARC cap that the RAM budget leaves room for.\noptions zfs zfs_arc_max=%s' "$arc_bytes")" || true
  fi

  if [ -n "$in_container" ]; then
    log "container: not applying sysctls or loading modules (they are global to the kernel)"
    return
  fi
  local key want
  while read -r key want; do
    [ "$(sysctl -n "$key")" = "$want" ] || change "sysctl $key=$want" sysctl -qw "$key=$want"
  done <<<$'vm.overcommit_memory 1\nvm.swappiness 1'
  local mod
  for mod in "${mods[@]}"; do
    module_present "$mod" || change "modprobe $mod" modprobe "$mod"
  done
  local arc_param=/sys/module/zfs/parameters/zfs_arc_max
  if [ -n "$arc_bytes" ] && [ "$(cat "$arc_param" 2>/dev/null)" != "$arc_bytes" ]; then
    change "set zfs_arc_max to $arc_bytes" write_param "$arc_param" "$arc_bytes"
  fi
  local swap
  swap=$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  log "swap: ${swap} MiB, left as it is"
}

# module_present MOD: loaded, or built into the kernel. A built-in module
# without parameters (tun on Ubuntu 26.04) has no /sys/module entry.
module_present() {
  [ -d "/sys/module/$1" ] || grep -q "/$1.ko" "/lib/modules/$(uname -r)/modules.builtin" 2>/dev/null
}

write_param() { echo "$2" >"$1"; }

memtotal_kib() { awk '/^MemTotal:/ { print $2 }' /proc/meminfo; }

# ensure_ksm [KSM_SYSFS]: with --ksm, ksmd runs now and at boot; with
# --no-ksm, its boot rule goes and run=2 stops ksmd and unmerges every merged
# page. A running imp keeps its merge flag until it restarts. KSM is global to
# the kernel, so a container refuses --ksm, and so does a kernel older than
# 6.10. KSM_SYSFS defaults to the kernel's /sys/kernel/mm/ksm.
ensure_ksm() {
  [ -n "$ksm" ] || return 0
  phase ksm
  local rule=/etc/tmpfiles.d/imp-ksm.conf sysfs=${1:-/sys/kernel/mm/ksm}
  if [ "$ksm" = off ]; then
    [ ! -f "$rule" ] || change "remove $rule" rm -f "$rule"
    [ -n "$in_container" ] || ! ksm_merges ||
      change "stop ksmd and unmerge its pages" write_param "$sysfs/run" 2
    return 0
  fi
  [ -z "$in_container" ] || die "--ksm cannot run in a container: KSM is global to the host's kernel"
  kernel_supports_ksm "$(uname -r)" || die "--ksm needs Linux 6.10 or later; this host runs $(uname -r)"
  [ -d "$sysfs" ] || die "--ksm needs a kernel built with CONFIG_KSM"
  put_file "$rule" 644 "$(ksm_tmpfiles)" || true
  local key
  for key in use_zero_pages run; do
    [ "$(cat "$sysfs/$key")" = 1 ] || change "set KSM $key=1" write_param "$sysfs/$key" 1
  done
}

# kernel_supports_ksm RELEASE: Linux 6.10 or later, the first that keeps
# the merge flag across exec and has ksmd scan the exec'd process.
kernel_supports_ksm() {
  version_ge "$(echo "$1" | grep -oE '^[0-9]+\.[0-9]+')" 6.10
}

# ksm_tmpfiles: the rule that starts ksmd at boot. Zero pages merge into the
# kernel's zero page; the scan rate stays the kernel's default.
ksm_tmpfiles() {
  printf '%s\n' '# Written by deploy/bootstrap.sh --ksm.' \
    'w /sys/kernel/mm/ksm/use_zero_pages - - - - 1' \
    'w /sys/kernel/mm/ksm/run - - - - 1'
}

# ksm_merges: ksmd runs, or pages it merged are still shared
ksm_merges() {
  local dir=${KSM_DIR:-/sys/kernel/mm/ksm}
  [ "$(cat "$dir/run" 2>/dev/null || echo 0)" = 1 ] ||
    [ "$(cat "$dir/pages_shared" 2>/dev/null || echo 0)" -gt 0 ]
}
