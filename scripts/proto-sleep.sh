#!/bin/bash
# Sleep/wake prototype (DESIGN.md 2.8, 2.9): Firecracker full snapshots, an
# in-memory proof that survives them, and virtio-balloon RAM reclamation.
# Prints measurements as "## key value" lines. Findings: docs/sleep-findings.md.
#
#   scripts/proto-sleep.sh [phase...]     phases: sleep big balloon (default: all)
#
# Env: IMP_DATA (default <repo>/.data-proto-sleep) holds this script's own XFS
#        file, so it never mounts the one smoke-boot.sh uses.
#      IMP_KERNEL (default <repo>/.cache/vmlinux-ci) is the guest kernel.
#      IMP_BUILD (default <repo>/build/proto-sleep) holds the agent and rootfs.
#      SLEEP_S (default 20) is how long the VM stays asleep.
set -euo pipefail
export IMP_BUILD=${IMP_BUILD:-$(cd "$(dirname "$0")/.." && pwd)/build/proto-sleep}
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

outer() {
  local data=${IMP_DATA:-$IMP_ROOT/.data-proto-sleep}
  local kernel=${IMP_KERNEL:-$IMP_ROOT/.cache/vmlinux-ci}

  ensure_host_image
  echo "== build agent + system drive"
  "$IMP_ROOT/scripts/build-system-drive.sh" >/dev/null
  if [ ! -f "$IMP_BUILD/rootfs.ext4" ]; then
    echo "== build rootfs from ubuntu:24.04"
    "$IMP_ROOT/scripts/build-rootfs.sh" ubuntu:24.04 "$IMP_BUILD/rootfs.ext4" >/dev/null
  fi
  mkdir -p "$data"
  echo "== run in host container (kernel $kernel)"
  docker run --rm --name "imp-proto-sleep-$$" --privileged --device /dev/kvm \
    -e IMP_STORAGE_GIB=40 -e SLEEP_S="${SLEEP_S:-20}" \
    -v "$IMP_ROOT:/w:ro" -v "$IMP_BUILD:/build:ro" -v "$data:/data" \
    -v "$(realpath "$kernel"):/kernel/vmlinux:ro" \
    "$IMP_HOST_IMAGE" /w/scripts/proto-sleep.sh --inner "$@"
}

# Everything below runs inside the host container.

lib=/var/lib/imp
dir=$lib/imps/proto-sleep
run=$dir/run
snap=$dir/snapshot
tap=imp10
host_ip=10.66.0.41
guest_ip=10.66.0.42
fc_pid=

now_ms() { echo $(($(date +%s%N) / 1000000)); }
m() { echo "## $*"; }

# api METHOD PATH [JSON]
api() {
  curl -sS --fail-with-body --unix-socket "$run/api.sock" -X "$1" \
    -H 'Content-Type: application/json' "http://localhost$2" ${3:+-d "$3"}
}

ctl() { /build/imp-agentctl -sock "$run/vsock.sock" "$@"; }
gx() { ctl exec -- sh -c "$1"; }

# fc_mem prints the Firecracker process's memory: RSS split from status,
# PSS from smaps_rollup. All in MiB.
fc_mem() {
  awk '/^(VmRSS|RssAnon|RssFile|RssShmem):/ {printf "%s=%d ", $1, $2/1024}' "/proc/$fc_pid/status"
  awk '/^(Pss|Private_Dirty|Shared_Clean|Private_Clean):/ {printf "%s=%d ", $1, $2/1024}' "/proc/$fc_pid/smaps_rollup"
  echo
}

fc_start() {
  rm -f "$run/api.sock"
  setsid firecracker --api-sock "$run/api.sock" >>"$run/firecracker.log" 2>&1 &
  fc_pid=$!
  for _ in $(seq 200); do [ -S "$run/api.sock" ] && return; sleep 0.01; done
  echo "firecracker API socket did not appear"; exit 1
}

fc_kill() {
  [ -n "$fc_pid" ] || return 0
  kill -9 "$fc_pid" 2>/dev/null || true
  while kill -0 "$fc_pid" 2>/dev/null; do sleep 0.01; done
  fc_pid=
}

# boot MEM_MIB [BALLOON_JSON] cold-boots the VM and waits for the agent.
boot() {
  local mem=$1 balloon=${2:-}
  rm -f "$run/vsock.sock"
  fc_start
  local args="console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"
  args+=" root=/dev/vdb rootfstype=squashfs ro init=/imp-agent"
  args+=" imp.hostname=sleepy imp.ip=$guest_ip/30 imp.gw=$host_ip imp.dns=1.1.1.1"
  api PUT /boot-source "{\"kernel_image_path\":\"$lib/system/vmlinux\",\"boot_args\":\"$args\"}"
  api PUT /machine-config "{\"vcpu_count\":2,\"mem_size_mib\":$mem}"
  api PUT /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$dir/disk.ext4\",\"is_root_device\":false,\"is_read_only\":false}"
  api PUT /drives/system "{\"drive_id\":\"system\",\"path_on_host\":\"$lib/system/imp-system.squashfs\",\"is_root_device\":false,\"is_read_only\":true}"
  api PUT /vsock "{\"guest_cid\":3,\"uds_path\":\"$run/vsock.sock\"}"
  api PUT /network-interfaces/eth0 "{\"iface_id\":\"eth0\",\"host_dev_name\":\"$tap\",\"guest_mac\":\"06:00:0a:42:00:2a\"}"
  [ -n "$balloon" ] && api PUT /balloon "$balloon"
  api PUT /actions '{"action_type":"InstanceStart"}'
  ctl ping -wait 15s >/dev/null
}

# sleep_vm pauses, snapshots to $snap/{vmstate,mem}, and kills Firecracker.
# Writes go to new files and are renamed in, because a VM restored with the
# File backend still maps the previous mem file.
sleep_vm() {
  local sync=${1:-true}
  mkdir -p "$snap"
  echo "fc before sleep: $(fc_mem)"
  local rss_kib; rss_kib=$(awk '/^VmRSS:/ {print $2}' "/proc/$fc_pid/status")
  local avail0; avail0=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  local t0 t1 t2
  t0=$(now_ms)
  api PATCH /vm '{"state":"Paused"}'
  t1=$(now_ms)
  api PUT /snapshot/create "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$snap/vmstate.new\",\"mem_file_path\":\"$snap/mem.new\",\"sync_snapshot_files\":$sync}"
  t2=$(now_ms)
  fc_kill
  mv "$snap/vmstate.new" "$snap/vmstate"
  mv "$snap/mem.new" "$snap/mem"
  local avail1; avail1=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  m "pause_ms $((t1 - t0))"
  m "snapshot_create_ms(sync=$sync) $((t2 - t1))"
  m "fc_rss_freed_mib $((rss_kib / 1024)) (MemAvailable delta $(((avail1 - avail0) / 1024)) MiB, noisy)"
  m "vmstate_bytes $(stat -c %s "$snap/vmstate")"
  m "mem_apparent $(du -h --apparent-size "$snap/mem" | cut -f1) mem_actual $(du -h "$snap/mem" | cut -f1)"
}

# dig_holes punches out the zero pages of the mem file. Firecracker writes
# every page, so the file is dense even when the guest never touched most of
# its memory; holes read back as zeros, so the restore is unchanged.
dig_holes() {
  local t0; t0=$(now_ms)
  fallocate --dig-holes "$snap/mem"
  m "dig_holes_ms $(($(now_ms) - t0)) mem_actual_after $(du -h "$snap/mem" | cut -f1)"
}

# wake_vm [EXTRA_LOAD_JSON] starts Firecracker, loads the snapshot, resumes
# and waits for the agent.
wake_vm() {
  local extra=${1:-}
  rm -f "$run/vsock.sock"
  fc_start
  local t0 t1 t2
  t0=$(now_ms)
  api PUT /snapshot/load "{\"snapshot_path\":\"$snap/vmstate\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$snap/mem\"},\"resume_vm\":true$extra}"
  t1=$(now_ms)
  ctl ping -wait 10s >/dev/null
  t2=$(now_ms)
  m "snapshot_load_ms $((t1 - t0)) load_to_ping_ms $((t2 - t1)) total_wake_ms $((t2 - t0))"
  echo "fc right after wake: $(fc_mem)"
}

# start_proof starts a detached process whose random value exists only in
# its memory. A fifo is the rendezvous; the value is never written to disk.
start_proof() {
  gx 'rm -f /tmp/q; mkfifo /tmp/q
      setsid -f sh -c '\''trap "" PIPE; echo $$ > /tmp/q.pid; v=$(od -An -N8 -tx8 /dev/urandom | tr -d " "); while :; do echo "$v" 2>/dev/null > /tmp/q; done'\'' </dev/null >/dev/null 2>&1'
  sleep 0.2
}

# proof_state prints the value, the writer's pid and starttime, the boot id
# and uptime. Only the pid is on disk; the value is not.
proof_state() {
  gx 'v=$(timeout 3 head -n1 /tmp/q || echo NONE)
      pid=$(cat /tmp/q.pid 2>/dev/null)
      st=$(cut -d" " -f22 /proc/$pid/stat 2>/dev/null)
      echo "value=$v pid=${pid:-none} starttime=${st:-none} boot_id=$(cat /proc/sys/kernel/random/boot_id) uptime=$(cut -d" " -f1 /proc/uptime)"'
}

guest_skew() {
  local g h
  g=$(gx 'date +%s%3N')
  h=$(now_ms)
  echo $((h - g))
}

cleanup() {
  local rc=$?
  if [ $rc -ne 0 ] && [ -f "$run/firecracker.log" ]; then
    echo "== FAILED (exit $rc); log tail:"
    tail -30 "$run/firecracker.log"
  fi
  [ -f "$run/firecracker.log" ] && cp "$run/firecracker.log" /data/proto-sleep-firecracker.log
  fc_kill
}

setup() {
  trap cleanup EXIT
  /w/host/scripts/setup-storage.sh >/dev/null
  /w/host/scripts/setup-net.sh >/dev/null
  install -m 0644 /kernel/vmlinux "$lib/system/vmlinux"
  install -m 0644 /build/imp-system.squashfs "$lib/system/imp-system.squashfs"
  mkdir -p "$lib/images/proto-sleep"
  cp --sparse=always /build/rootfs.ext4 "$lib/images/proto-sleep/rootfs.ext4"
  ip tuntap add "$tap" mode tap
  ip addr add "$host_ip/30" dev "$tap"
  ip link set "$tap" up
  m "firecracker $(firecracker --version | head -1) snapshot_format $(firecracker --snapshot-version)"
}

fresh_disk() {
  rm -rf "$dir"
  mkdir -p "$run"
  cp --reflink=always "$lib/images/proto-sleep/rootfs.ext4" "$dir/disk.ext4"
}

# phase_sleep MEM_MIB TOUCH_MIB: the in-memory proof across three sleep/wake
# cycles, exec sessions and the clock across a sleep, the restore
# prerequisites, then a cold-boot negative control.
phase_sleep() {
  local mem=$1 touch=$2 slp=${SLEEP_S:-20}
  echo "=== phase sleep: ${mem} MiB guest, ${touch} MiB touched"
  fresh_disk
  boot "$mem"
  echo "fc after boot: $(fc_mem)"
  start_proof
  local before; before=$(proof_state)
  echo "before: $before"
  if [ "$touch" -gt 0 ]; then
    gx "head -c ${touch}M /dev/urandom > /dev/shm/blob && md5sum /dev/shm/blob > /tmp/blob.md5"
    local t0; t0=$(now_ms)
    gx "md5sum -c --quiet /tmp/blob.md5"
    m "md5_${touch}MiB_awake_ms $(($(now_ms) - t0))"
  fi
  # Foreground exec sessions open across the sleep: one obeys SIGHUP, one
  # ignores it.
  local bg=()
  ctl exec -- sleep 600 </dev/null >/dev/null 2>&1 &
  bg+=($!)
  ctl exec -- sh -c 'trap "" HUP; exec sleep 601' </dev/null >/dev/null 2>&1 &
  bg+=($!)
  sleep 0.5
  echo "activity before sleep: $(ctl activity)"
  m "guest_skew_ms_before_sleep $(guest_skew)"

  echo "== cycle 1: sleep ${slp}s"
  sleep_vm true
  wait "${bg[@]}" 2>/dev/null || true # the host ends saw EOF
  sleep "$slp"
  wake_vm
  m "guest_skew_ms_after_wake $(guest_skew)"
  ctl resumed >/dev/null
  m "guest_skew_ms_after_resumed $(guest_skew)"
  local after; after=$(proof_state)
  echo "after:  $after"
  [ "${before%% uptime=*}" = "${after%% uptime=*}" ] || { echo "PROOF FAILED: state differs"; exit 1; }
  echo "proof ok: same value, pid, starttime and boot id"
  sleep 1.5
  echo "activity after wake: $(ctl activity)"
  gx 'echo "sleep processes left: $(pgrep -a -x sleep | tr "\n" ";")"'
  if [ "$touch" -gt 0 ]; then
    local t0; t0=$(now_ms)
    gx 'md5sum -c --quiet /tmp/blob.md5 && echo "blob intact"'
    m "touch_${touch}MiB_ms $(($(now_ms) - t0))"
    echo "fc after touching the blob: $(fc_mem)"
  fi
  gx 'dmesg | grep -i -E "vmgenid|crng|clocksource|vsock|vmclock" | tail -8' || true
  grep -E 'imp-agent: (fatal|accept|listen)' "$run/firecracker.log" || echo "no agent accept/fatal errors on the console"

  echo "== cycle 2: sleep 3s, stale vsock socket, cold page cache, clock_realtime"
  sleep_vm false
  sleep 3
  # A leftover vsock socket file: Firecracker cannot bind it.
  touch "$run/vsock.sock"
  fc_start
  if api PUT /snapshot/load "{\"snapshot_path\":\"$snap/vmstate\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$snap/mem\"},\"resume_vm\":true}"; then
    echo "UNEXPECTED: load with a stale vsock socket succeeded"
  fi
  echo
  sleep 0.2
  kill -0 "$fc_pid" 2>/dev/null && echo "firecracker still alive after failed load" || echo "firecracker exited after failed load"
  fc_kill
  m "describe_snapshot $(firecracker --describe-snapshot "$snap/vmstate")"
  dd of="$snap/mem" oflag=nocache conv=notrunc,fdatasync count=0 status=none
  wake_vm ',"clock_realtime":true'
  m "guest_skew_ms_with_clock_realtime $(guest_skew)"
  echo "after cycle 2: $(proof_state)"

  echo "== cycle 3: tap and vsock overrides"
  sleep_vm true
  dig_holes
  ip addr del "$host_ip/30" dev "$tap"
  ip tuntap add imp11 mode tap
  ip addr add "$host_ip/30" dev imp11
  ip link set imp11 up
  local old_run=$run
  run=$dir/run2
  mkdir -p "$run"
  rm -f "$run/api.sock"
  setsid firecracker --api-sock "$run/api.sock" >>"$old_run/firecracker.log" 2>&1 &
  fc_pid=$!
  for _ in $(seq 200); do [ -S "$run/api.sock" ] && break; sleep 0.01; done
  api PUT /snapshot/load "{\"snapshot_path\":\"$snap/vmstate\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$snap/mem\"},\"resume_vm\":true,\"network_overrides\":[{\"iface_id\":\"eth0\",\"host_dev_name\":\"imp11\"}],\"vsock_override\":{\"uds_path\":\"$run/vsock.sock\"}}"
  ctl ping -wait 10s
  ctl resumed >/dev/null
  echo "after overrides: $(proof_state)"
  gx 'timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/53" && echo "egress via imp11 ok" || echo "egress via imp11 FAILED"'
  ctl shutdown >/dev/null
  for _ in $(seq 100); do kill -0 "$fc_pid" 2>/dev/null || break; sleep 0.05; done
  fc_kill
  ip link del imp11
  ip addr add "$host_ip/30" dev "$tap"
  run=$old_run

  echo "== negative control: cold boot of the same disk"
  boot "$mem"
  echo "cold:   $(proof_state)"
  ctl shutdown >/dev/null
  for _ in $(seq 100); do kill -0 "$fc_pid" 2>/dev/null || break; sleep 0.05; done
  fc_kill
}

# fc_rss_mib prints Firecracker's RSS in MiB.
fc_rss_mib() { awk '/^VmRSS:/ {print int($2/1024)}' "/proc/$fc_pid/status"; }

# alloc_free: fill 900 MiB of guest memory, free it, sample host RSS.
alloc_free() {
  echo "  idle rss=$(fc_rss_mib)"
  gx 'head -c 900M /dev/zero > /dev/shm/big'
  echo "  tmpfs 900 MiB allocated: rss=$(fc_rss_mib)"
  gx 'rm /dev/shm/big'
  local t
  for t in 1 3 6 15; do
    sleep $((t - ${prev:-0}))
    prev=$t
    echo "  +${t}s after free: rss=$(fc_rss_mib)"
  done
  unset prev
  gx 'perl -e '\''$x = "a" x (700<<20); print "perl 700 MiB string\n"'\'''
  sleep 6
  echo "  +6s after a 700 MiB anonymous alloc exited: rss=$(fc_rss_mib)"
  sleep 9
  echo "  +15s after a 700 MiB anonymous alloc exited: rss=$(fc_rss_mib)"
}

phase_balloon() {
  echo "=== phase balloon: 2048 MiB guests"
  local base='"amount_mib":0,"deflate_on_oom":true,"stats_polling_interval_s":1'

  echo "== control: no balloon device"
  fresh_disk
  boot 2048
  alloc_free
  shutdown_fc

  echo "== free_page_reporting"
  fresh_disk
  boot 2048 "{$base,\"free_page_reporting\":true}"
  gx 'cat /sys/module/page_reporting/parameters/page_reporting_order 2>/dev/null | sed "s/^/page_reporting_order=/"; true'
  alloc_free
  echo "  stats: $(api GET /balloon/statistics)"
  echo "  config: $(api GET /balloon)"
  echo "  inflate balloon to 1024 MiB"
  api PATCH /balloon '{"amount_mib":1024}'
  sleep 3
  echo "  stats: $(api GET /balloon/statistics) rss=$(fc_rss_mib)"
  api PATCH /balloon '{"amount_mib":0}'
  sleep 2
  echo "== snapshot of a reporting VM after the free"
  sleep_vm true
  dig_holes
  wake_vm
  echo "  balloon after wake: $(api GET /balloon/statistics)"
  shutdown_fc

  echo "== free_page_hinting (developer preview)"
  fresh_disk
  boot 2048 "{$base,\"free_page_hinting\":true}"
  alloc_free
  local t0; t0=$(now_ms)
  api PATCH /balloon/hinting/start '{"acknowledge_on_stop":true}'
  for _ in 1 2 3 4 5; do
    sleep 0.2
    echo "  +$(($(now_ms) - t0)) ms: $(api GET /balloon/hinting/status) rss=$(fc_rss_mib)"
  done
  sleep 2
  echo "  +2s: rss=$(fc_rss_mib)"
  shutdown_fc
}

shutdown_fc() {
  ctl shutdown >/dev/null || true
  for _ in $(seq 100); do kill -0 "$fc_pid" 2>/dev/null || break; sleep 0.05; done
  fc_kill
}

inner() {
  setup
  local phases=("$@")
  [ ${#phases[@]} -gt 0 ] || phases=(sleep big balloon)
  for p in "${phases[@]}"; do
    case $p in
      sleep) phase_sleep 1024 0 ;;
      big) phase_sleep 2048 300 ;;
      balloon) phase_balloon ;;
      *) echo "unknown phase $p"; exit 2 ;;
    esac
  done
  echo "== DONE"
}

if [ "${1:-}" = --inner ]; then
  shift
  inner "$@"
else
  outer "$@"
fi
