#!/bin/bash
# Walking-skeleton proof: boot one imp with imp-agent as PID 1 and drive it
# over vsock. Builds everything, then runs the VM inside the host container.
#
#   scripts/smoke-boot.sh
#
# Env: IMP_DATA (default <repo>/.data) holds the sparse XFS file across runs.
#      IMP_KERNEL (default <repo>/.cache/vmlinux-ci) is the guest kernel.
#      IMP_SMOKE_IMAGE (default ubuntu:24.04) is the user image.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

outer() {
  local data=${IMP_DATA:-$IMP_ROOT/.data}
  local kernel=${IMP_KERNEL:-$IMP_ROOT/.cache/vmlinux-ci}
  local image=${IMP_SMOKE_IMAGE:-ubuntu:24.04}

  echo "== build host image"
  docker build -q -t "$IMP_HOST_IMAGE" "$IMP_ROOT/host" >/dev/null
  echo "== build system drive"
  "$IMP_ROOT/scripts/build-system-drive.sh" >/dev/null
  echo "== build rootfs from $image"
  "$IMP_ROOT/scripts/build-rootfs.sh" "$image" "$IMP_BUILD/smoke-rootfs.ext4" >/dev/null

  mkdir -p "$data"
  echo "== boot in host container"
  docker run --rm --privileged --device /dev/kvm \
    -e IMP_STORAGE_GIB="${IMP_STORAGE_GIB:-200}" \
    -v "$IMP_ROOT:/w:ro" -v "$IMP_BUILD:/build:ro" -v "$data:/data" \
    -v "$(realpath "$kernel"):/kernel/vmlinux:ro" \
    "$IMP_HOST_IMAGE" /w/scripts/smoke-boot.sh --inner
}

# Everything below runs inside the host container.

lib=/var/lib/imp
id=smoke
dir=$lib/imps/$id
run=$dir/run
tap=imp0
fc_pid=

api() {
  curl -sS --fail-with-body --unix-socket "$run/api.sock" -X PUT \
    -H 'Content-Type: application/json' "http://localhost$1" -d "$2"
}

ctl() {
  /build/imp-agentctl -sock "$run/vsock.sock" "$@"
}

now_ms() {
  echo $(($(date +%s%N) / 1000000))
}

cleanup() {
  local rc=$?
  if [ $rc -ne 0 ] && [ -f "$run/firecracker.log" ]; then
    echo "== FAILED (exit $rc); serial/firecracker log tail:"
    tail -40 "$run/firecracker.log"
  fi
  [ -f "$run/firecracker.log" ] && cp "$run/firecracker.log" /data/smoke-firecracker.log
  [ -n "$fc_pid" ] && kill "$fc_pid" 2>/dev/null || true
  ip link del "$tap" 2>/dev/null || true
}

# boot_vm starts Firecracker on $dir/disk.ext4 and waits for the agent.
boot_vm() {
  rm -f "$run/api.sock" "$run/vsock.sock"
  setsid firecracker --api-sock "$run/api.sock" >"$run/firecracker.log" 2>&1 &
  fc_pid=$!
  for _ in $(seq 100); do [ -S "$run/api.sock" ] && break; sleep 0.01; done

  local args="console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"
  args+=" root=/dev/vdb rootfstype=squashfs ro init=/imp-agent"
  args+=" imp.hostname=smoke imp.ip=10.66.0.2/30 imp.gw=10.66.0.1 imp.dns=1.1.1.1"
  api /boot-source "{\"kernel_image_path\":\"$lib/system/vmlinux\",\"boot_args\":\"$args\"}"
  api /machine-config '{"vcpu_count":2,"mem_size_mib":1024}'
  # Drives enumerate in PUT order: rootfs is vda, the system drive vdb.
  # Neither is a Firecracker "root device", which would append root=/dev/vda.
  api /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$dir/disk.ext4\",\"is_root_device\":false,\"is_read_only\":false}"
  api /drives/system "{\"drive_id\":\"system\",\"path_on_host\":\"$lib/system/imp-system.squashfs\",\"is_root_device\":false,\"is_read_only\":true}"
  api /vsock "{\"guest_cid\":3,\"uds_path\":\"$run/vsock.sock\"}"
  api /network-interfaces/eth0 "{\"iface_id\":\"eth0\",\"host_dev_name\":\"$tap\",\"guest_mac\":\"06:00:0a:42:00:02\"}"

  local t0; t0=$(now_ms)
  api /actions '{"action_type":"InstanceStart"}'
  local tstart; tstart=$(now_ms)
  ctl ping -wait 15s
  local tping; tping=$(now_ms)
  echo "== InstanceStart -> first agent ping: $((tping - t0)) ms (API call $((tstart - t0)) ms)"
}

# shutdown_vm asks the agent to power off and waits for Firecracker to exit.
shutdown_vm() {
  ctl shutdown
  for _ in $(seq 100); do kill -0 "$fc_pid" 2>/dev/null || break; sleep 0.05; done
  if kill -0 "$fc_pid" 2>/dev/null; then
    echo "firecracker still running 5s after shutdown"
    exit 1
  fi
  fc_pid=
  echo "firecracker exited"
}

inner() {
  trap cleanup EXIT
  /w/host/scripts/setup-storage.sh
  /w/host/scripts/setup-net.sh

  install -m 0644 /kernel/vmlinux "$lib/system/vmlinux"
  install -m 0644 /build/imp-system.squashfs "$lib/system/imp-system.squashfs"
  mkdir -p "$lib/images/smoke"
  cp --sparse=always /build/smoke-rootfs.ext4 "$lib/images/smoke/rootfs.ext4"

  rm -rf "$dir"
  mkdir -p "$run"
  local t; t=$(now_ms)
  cp --reflink=always "$lib/images/smoke/rootfs.ext4" "$dir/disk.ext4"
  echo "== reflink clone of $(du -h --apparent-size "$dir/disk.ext4" | cut -f1) disk: $(($(now_ms) - t)) ms"

  ip tuntap add "$tap" mode tap
  ip addr add 10.66.0.1/30 dev "$tap"
  ip link set "$tap" up

  boot_vm

  echo "== exec uname -a"
  ctl exec -- uname -a
  echo "== exec cat /etc/os-release"
  ctl exec -- cat /etc/os-release
  echo "== exec network + DNS"
  ctl exec -- sh -c 'ping -c1 -W2 1.1.1.1 || true; getent hosts example.com'
  ctl exec -- bash -c 'getent ahostsv4 example.com | head -1 && timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/53" && echo "tcp egress to 1.1.1.1:53 ok"'
  echo "== exec stdin"
  [ "$(echo hello-stdin | ctl exec -- cat)" = hello-stdin ] || { echo "stdin round trip failed"; exit 1; }
  echo "stdin round trip ok"
  echo "== exec exit code and stderr"
  local rc=0
  ctl exec -- sh -c 'echo to-stderr >&2; exit 7' || rc=$?
  [ "$rc" -eq 7 ] || { echo "expected exit 7, got $rc"; exit 1; }
  echo "exit code 7 propagated"
  if ctl exec -- /no/such/binary 2>&1; then echo "expected EXEC_FAILED"; exit 1; fi
  echo "== exec with tty"
  ctl exec -t -- sh -c 'tty; stty size'
  echo "== activity (idle, then with an open TCP connection and exec session)"
  ctl activity
  ctl exec -- bash -c 'exec 3<>/dev/tcp/1.1.1.1/80; sleep 3' </dev/null &
  local bg=$!
  sleep 1
  ctl activity
  wait "$bg" # a bare wait would also wait for firecracker
  echo "== agent console lines"
  grep 'imp-agent:' "$run/firecracker.log" || true

  echo "== freeze / thaw"
  ctl freeze
  ctl thaw
  # A write to a still-frozen / would block until the auto-thaw.
  timeout 5 /build/imp-agentctl -sock "$run/vsock.sock" exec -- sh -c 'echo thawed > /tmp/thawed && cat /tmp/thawed'
  echo "== exec as another user"
  ctl exec -u nobody -- id

  echo "== install a test service, then shutdown"
  ctl exec -- sh -c 'mkdir -p /etc/imp/services.d && printf "%s" "{\"argv\":[\"sh\",\"-c\",\"echo tick; sleep 0.2; exit 3\"]}" > /etc/imp/services.d/ticker.json'
  shutdown_vm

  echo "== second cold boot of the same disk"
  boot_vm
  sleep 3.5
  ctl services.list
  ctl exec -- sh -c 'test -f /etc/imp/services.d/ticker.json && echo "disk writes persisted"; printf "ticker.log lines: "; wc -l < /var/log/imp/ticker.log'
  echo "== shutdown"
  shutdown_vm
  echo "== PASS"
}

if [ "${1:-}" = --inner ]; then
  inner
else
  outer
fi
