#!/bin/bash
# M4 proof: boot images/base on the custom kernel (kernel/out/vmlinux) and
# run Docker inside the guest: info, hello-world, build, a published port
# through the bridge, and egress from a container. Also measures boot time
# on both kernels and the idle memory footprint with dockerd running.
#
#   scripts/smoke-docker.sh
#
# Env: IMP_DATA (default <repo>/.data/smoke-docker) holds its own sparse
#        XFS file, so it never shares a loop mount with smoke-boot.sh.
#      IMP_KERNEL (default <repo>/kernel/out/vmlinux) is the guest kernel.
#      IMP_CI_KERNEL (default <repo>/.cache/vmlinux-ci) is the comparison kernel.
#      IMP_BASE_IMAGE (default imp/base) is the image tag to build and boot.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

outer() {
  local data=${IMP_DATA:-$IMP_ROOT/.data/smoke-docker}
  local kernel=${IMP_KERNEL:-$IMP_ROOT/kernel/out/vmlinux}
  local ci_kernel=${IMP_CI_KERNEL:-$IMP_ROOT/.cache/vmlinux-ci}
  local image=${IMP_BASE_IMAGE:-imp/base}

  echo "== build host image"
  ensure_host_image
  echo "== build system drive"
  "$IMP_ROOT/scripts/build-system-drive.sh" >/dev/null
  echo "== build $image from images/base"
  docker build -q -t "$image" "$IMP_ROOT/images/base" >/dev/null
  echo "== build rootfs from $image"
  "$IMP_ROOT/scripts/build-rootfs.sh" "$image" "$IMP_BUILD/smoke-docker-rootfs.ext4" >/dev/null

  # The host container's eth0 says 1500 even when the real uplink is
  # smaller (WSL2: 1360), and no ICMP "fragmentation needed" makes it back
  # to a guest. Pass the real MTU in so inner() can clamp the TCP MSS.
  local uplink mtu
  uplink=$(ip route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1); exit}')
  mtu=$(cat "/sys/class/net/$uplink/mtu")

  mkdir -p "$data"
  echo "== boot in host container (uplink $uplink mtu $mtu)"
  docker run --rm --name imp-smoke-docker --privileged --device /dev/kvm \
    -e IMP_STORAGE_GIB="${IMP_STORAGE_GIB:-200}" -e IMP_UPLINK_MTU="$mtu" \
    -v "$IMP_ROOT:/w:ro" -v "$IMP_BUILD:/build:ro" -v "$data:/data" \
    -v "$(realpath "$kernel"):/kernel/vmlinux:ro" \
    -v "$(realpath "$ci_kernel"):/kernel/vmlinux-ci:ro" \
    "$IMP_HOST_IMAGE" /w/scripts/smoke-docker.sh --inner
}

# Everything below runs inside the host container.

lib=/var/lib/imp
id=smoke-docker
dir=$lib/imps/$id
run=$dir/run
tap=imp9
host_ip=10.66.0.37
guest_ip=10.66.0.38
fc_pid=

api() {
  curl -sS --fail-with-body --unix-socket "$run/api.sock" -X PUT \
    -H 'Content-Type: application/json' "http://localhost$1" -d "$2"
}

ctl() {
  /build/imp-agentctl -sock "$run/vsock.sock" "$@"
}

# gx runs a shell command in the guest.
gx() {
  ctl exec -- sh -c "$1"
}

now_ms() {
  echo $(($(date +%s%N) / 1000000))
}

cleanup() {
  local rc=$?
  if [ $rc -ne 0 ] && [ -f "$run/firecracker.log" ]; then
    echo "== FAILED (exit $rc); serial/firecracker log tail:"
    tail -40 "$run/firecracker.log"
    echo "== dockerd log tail:"
    timeout 5 /build/imp-agentctl -sock "$run/vsock.sock" exec -- tail -30 /var/log/imp/docker.log || true
  fi
  [ -f "$run/firecracker.log" ] && cp "$run/firecracker.log" /data/smoke-docker-firecracker.log
  [ -n "$fc_pid" ] && kill "$fc_pid" 2>/dev/null || true
  ip link del "$tap" 2>/dev/null || true
}

# boot_vm KERNEL MEM_MIB starts Firecracker on $dir/disk.ext4, waits for the
# agent and sets boot_ms to InstanceStart -> first agent ping.
boot_ms=
boot_vm() {
  local kernel=$1 mem=$2
  rm -f "$run/api.sock" "$run/vsock.sock"
  setsid firecracker --api-sock "$run/api.sock" >"$run/firecracker.log" 2>&1 &
  fc_pid=$!
  for _ in $(seq 100); do [ -S "$run/api.sock" ] && break; sleep 0.01; done

  local args="console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"
  args+=" root=/dev/vdb rootfstype=squashfs ro init=/imp-agent"
  args+=" imp.hostname=$id imp.ip=$guest_ip/30 imp.gw=$host_ip imp.dns=1.1.1.1"
  api /boot-source "{\"kernel_image_path\":\"$kernel\",\"boot_args\":\"$args\"}"
  api /machine-config "{\"vcpu_count\":2,\"mem_size_mib\":$mem}"
  api /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$dir/disk.ext4\",\"is_root_device\":false,\"is_read_only\":false}"
  api /drives/system "{\"drive_id\":\"system\",\"path_on_host\":\"$lib/system/imp-system.squashfs\",\"is_root_device\":false,\"is_read_only\":true}"
  api /vsock "{\"guest_cid\":3,\"uds_path\":\"$run/vsock.sock\"}"
  api /network-interfaces/eth0 "{\"iface_id\":\"eth0\",\"host_dev_name\":\"$tap\",\"guest_mac\":\"06:00:0a:42:00:26\"}"

  local t0; t0=$(now_ms)
  api /actions '{"action_type":"InstanceStart"}'
  ctl ping -wait 15s >/dev/null
  boot_ms=$(($(now_ms) - t0))
}

shutdown_vm() {
  ctl shutdown >/dev/null
  for _ in $(seq 200); do kill -0 "$fc_pid" 2>/dev/null || break; sleep 0.05; done
  if kill -0 "$fc_pid" 2>/dev/null; then
    echo "firecracker still running 10s after shutdown"
    exit 1
  fi
  fc_pid=
}

# boot_times LABEL KERNEL boots the disk 3 times and prints each boot time.
boot_times() {
  local label=$1 kernel=$2 times=()
  for _ in 1 2 3; do
    boot_vm "$kernel" 2048
    times+=("$boot_ms")
    shutdown_vm
  done
  echo "== $label kernel: InstanceStart -> agent ping: ${times[*]} ms"
}

inner() {
  trap cleanup EXIT
  /w/host/scripts/setup-storage.sh
  /w/host/scripts/setup-net.sh

  install -m 0644 /kernel/vmlinux "$lib/system/vmlinux-docker"
  install -m 0644 /kernel/vmlinux-ci "$lib/system/vmlinux-ci"
  install -m 0644 /build/imp-system.squashfs "$lib/system/imp-system.squashfs"
  mkdir -p "$lib/images/smoke-docker"
  cp --sparse=always /build/smoke-docker-rootfs.ext4 "$lib/images/smoke-docker/rootfs.ext4"

  rm -rf "$dir"
  mkdir -p "$run"
  cp --reflink=always "$lib/images/smoke-docker/rootfs.ext4" "$dir/disk.ext4"

  ip tuntap add "$tap" mode tap
  ip addr add "$host_ip/30" dev "$tap"
  ip link set "$tap" up
  # Stand-in for a host/scripts/setup-net.sh rule: without it, TLS
  # handshakes with a large ClientHello (Go, so dockerd pulls) stall.
  local mtu=${IMP_UPLINK_MTU:-1500}
  if [ "$mtu" -lt 1500 ]; then
    for dir_flag in -i -o; do
      iptables -t mangle -A FORWARD "$dir_flag" "$tap" -p tcp --tcp-flags SYN,RST SYN \
        -j TCPMSS --set-mss $((mtu - 40))
    done
    echo "clamped TCP MSS on $tap to $((mtu - 40))"
  fi

  # Same disk, same 2 vCPU / 2 GiB shape. On the CI kernel dockerd fails
  # (no nftables) but the agent boot is still comparable.
  boot_times CI "$lib/system/vmlinux-ci"
  boot_times custom "$lib/system/vmlinux-docker"

  boot_vm "$lib/system/vmlinux-docker" 2048
  echo "== boot for docker tests: ${boot_ms} ms"
  gx 'uname -r; cat /proc/cmdline'

  echo "== wait for dockerd"
  local t0; t0=$(now_ms)
  for _ in $(seq 300); do
    gx 'docker info >/dev/null 2>&1' && break
    sleep 0.1
  done
  echo "dockerd ready $(($(now_ms) - t0)) ms after agent ping"
  ctl services.list

  echo "== docker info"
  gx 'docker info --format "server {{.ServerVersion}} storage={{.Driver}} cgroup={{.CgroupDriver}} v{{.CgroupVersion}} kernel={{.KernelVersion}}"; docker info 2>&1 | grep -i warn || echo "no warnings"'

  echo "== idle footprint (dockerd up, no containers)"
  sleep 5
  gx 'free -m; ps -eo rss,comm --sort=-rss | head -4'
  echo "firecracker $(grep -E '^(Rss|Pss):' "/proc/$fc_pid/smaps_rollup" | awk '{printf "%s %d MiB  ", $1, $2/1024}')"

  echo "== docker run --rm hello-world"
  gx 'docker run --rm hello-world' | grep 'Hello from Docker!'

  echo "== docker build"
  gx 'mkdir -p /tmp/b && printf "FROM alpine:3.20\nRUN echo built-in-imp > /msg\nCMD [\"cat\", \"/msg\"]\n" > /tmp/b/Dockerfile && docker build -q -t imp-smoke-build /tmp/b && docker run --rm imp-smoke-build' | grep built-in-imp

  echo "== published port through the bridge"
  gx 'docker run -d --name web -p 8081:80 nginx:alpine >/dev/null'
  gx 'for i in $(seq 50); do curl -fsS localhost:8081 >/dev/null 2>&1 && break; sleep 0.2; done; curl -fsS localhost:8081' | grep -o '<title>.*</title>'
  echo "from the host container to $guest_ip:8081 (DNAT on eth0)"
  curl -fsS "http://$guest_ip:8081" | grep -o '<title>.*</title>'

  echo "== egress from a container (DNS + HTTP)"
  gx 'docker run --rm alpine:3.20 sh -c "nslookup example.com >/dev/null && wget -qO- http://example.com" | grep -o "<title>.*</title>"'

  echo "== footprint after the tests (nginx running)"
  gx 'free -m | sed -n 2p; docker ps --format "{{.Names}} {{.Status}}"'
  echo "firecracker $(grep -E '^(Rss|Pss):' "/proc/$fc_pid/smaps_rollup" | awk '{printf "%s %d MiB  ", $1, $2/1024}')"

  echo "== shutdown, cold boot, dockerd comes back"
  shutdown_vm
  boot_vm "$lib/system/vmlinux-docker" 2048
  for _ in $(seq 300); do gx 'docker info >/dev/null 2>&1' && break; sleep 0.1; done
  gx 'docker info --format "server {{.ServerVersion}} up again"; docker start web >/dev/null && sleep 1 && curl -fsS localhost:8081 | grep -o "<title>.*</title>"'
  shutdown_vm
  echo "== PASS"
}

if [ "${1:-}" = --inner ]; then
  inner
else
  outer
fi
