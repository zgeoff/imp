#!/bin/bash
# Run deploy/bootstrap.sh for real inside a throwaway container with systemd
# as PID 1, on Debian 13 and Ubuntu 24.04, and check that a second run
# changes nothing.
#
#   scripts/test-bootstrap.sh --image imp-host:<tag>   a local release image
#   scripts/test-bootstrap.sh --stub                   a stand-in image (CI)
#   scripts/test-bootstrap.sh --image ... --health     also create and exec an imp (needs KVM)
#   scripts/test-bootstrap.sh --distro debian ...      one distro only
#   scripts/test-bootstrap.sh --keep ...               leave a failed container to inspect
#
# HOST SAFETY. The container is privileged and shares the host's kernel, so:
# - it has its own network namespace (never --network host): the firewall
#   and Docker's rules inside it never reach the host;
# - systemd-sysctl, systemd-modules-load, systemd-udevd and systemd-binfmt
#   are masked in the image, and bootstrap.sh itself writes kernel settings
#   in a container but does not apply them;
# - storage is a loop file in the container, never a disk; the EXIT trap
#   unmounts it and detaches its loop device (loop devices are global);
# - every run is bracketed by a snapshot of the vm.* and kernel.* sysctls
#   and the loaded modules, and the test fails on any difference.
set -euo pipefail
cd "$(dirname "$0")/.."

image=
stub=
health=
keep=
distros=(debian ubuntu)

while [ $# -gt 0 ]; do
  case $1 in
    --image) image=${2:?--image needs a reference} && shift ;;
    --stub) stub=1 ;;
    --health) health=1 ;;
    --keep) keep=1 ;;
    --distro) distros=("${2:?--distro needs debian or ubuntu}") && shift ;;
    *) echo "test-bootstrap: unknown argument: $1" >&2 && exit 2 ;;
  esac
  shift
done
if [ -z "$image" ] && [ -z "$stub" ]; then
  echo "test-bootstrap: give --image REF or --stub" >&2
  exit 2
fi
if [ -n "$stub" ] && [ -n "$health" ]; then
  echo "test-bootstrap: --health needs a real --image" >&2
  exit 2
fi

work=$(mktemp -d)
container=
loop_file=/var/imp.xfs

log() { echo "test-bootstrap: $*"; }
fail() {
  echo "test-bootstrap: FAIL: $*" >&2
  exit 1
}

# kernel_state: the global kernel state a container could change. Counters
# and values that move on their own are left out.
kernel_state() {
  sysctl -a 2>/dev/null \
    | grep -E '^(vm|kernel)\.' \
    | grep -vE '^kernel\.(random\.|ns_last_pid|pty\.nr|sched_domain\.|perf_event_max_sample_rate|tainted)' || true
  awk '{ print "module", $1 }' /proc/modules | sort
}

# teardown: stop the test container. The loop file is unmounted inside it
# first: its loop device is the host's, and removing the container would
# leave it attached.
teardown() {
  [ -n "$container" ] || return 0
  docker exec "$container" bash -c '
    systemctl stop imp-host 2>/dev/null
    ! mountpoint -q /var/lib/imp || umount /var/lib/imp
    for dev in $(losetup --list -n -O NAME -j '"$loop_file"'); do losetup -d "$dev"; done
  ' || echo "test-bootstrap: WARNING: teardown in $container failed; check losetup -l" >&2
  docker rm -f -v "$container" >/dev/null
  container=
}

cleanup() {
  if [ -n "$keep" ] && [ -n "$container" ]; then
    echo "test-bootstrap: kept $container; remove it with: docker exec $container umount /var/lib/imp; docker rm -f -v $container" >&2
    return
  fi
  teardown
  rm -rf "$work"
}
trap cleanup EXIT

if [ -n "$stub" ]; then
  # Stands in for the release image: the unit runs it with the same flags,
  # so every phase but the health check runs as on a server.
  image=imp-host-stub:test
  docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie-slim
CMD ["sleep", "infinity"]
EOF
fi
# Not a real key: a marker the test looks for in the output.
fake_key=fake-authkey-$$-$RANDOM
printf '%s\n' "$fake_key" >"$work/authkey"
log "saving $image"
docker image inspect "$image" >/dev/null || fail "no local image $image"
docker save -o "$work/image.tar" "$image"

build_image() {
  local distro=$1 base extra=
  case $distro in
    debian) base=debian:trixie ;;
    # Vultr's Ubuntu images ship ufw enabled; the test does the same.
    ubuntu) base=ubuntu:24.04 extra=ufw ;;
  esac
  docker build -q -t "imp-bootstrap-test:$distro" --build-arg BASE="$base" --build-arg EXTRA="$extra" - >/dev/null <<'EOF'
ARG BASE
FROM ${BASE}
ARG EXTRA
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server procps iproute2 ca-certificates ${EXTRA} \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/sbin/policy-rc.d
# policy-rc.d (above) stops services from starting on install in a Docker
# image; a server has none. These write kernel-global state (sysctls, modules, binfmt) or touch host
# devices; the container shares the host's kernel.
RUN systemctl mask systemd-sysctl.service systemd-modules-load.service \
      systemd-udevd.service systemd-udevd-control.socket systemd-udevd-kernel.socket \
      systemd-udev-trigger.service systemd-binfmt.service proc-sys-fs-binfmt_misc.automount \
      systemd-timesyncd.service getty@tty1.service console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
}

# in_container CMD...: run CMD in the test container.
in_container() { docker exec "$container" "$@"; }

bootstrap() {
  local mode=$1 before after rc=0 out
  local args=("$mode" --loop-file "$loop_file" --loop-size 50
    --image "$image" --image-archive /mnt/archive/image.tar)
  [ -n "$health" ] || args+=(--skip-health)
  # The stub never starts tailscaled, so it can carry a fake key; the real
  # image would try to join with it.
  [ -z "$stub" ] || args+=(--tailscale-authkey-file /mnt/archive/authkey)
  before=$(kernel_state)
  out=$(in_container /root/bootstrap.sh "${args[@]}" 2>&1) || rc=$?
  after=$(kernel_state)
  local line
  while IFS= read -r line; do echo "  | $line"; done <<<"$out"
  if [ "$before" != "$after" ]; then
    diff <(echo "$before") <(echo "$after") >&2 || true
    fail "the host's kernel state changed during bootstrap.sh $mode"
  fi
  LAST_OUTPUT=$out
  return "$rc"
}

# wait_for_imp_host: the unit's container runs, for 30 s at most.
wait_for_imp_host() {
  local i
  for i in $(seq 30); do
    [ "$(in_container docker inspect -f '{{.State.Running}}' imp-host 2>/dev/null)" = true ] && return 0
    [ "$i" = 30 ] || sleep 1
  done
  in_container journalctl -u imp-host --no-pager -n 20 >&2
  return 1
}

run_distro() {
  local distro=$1
  log "[$distro] building the systemd image"
  build_image "$distro"
  container=imp-bootstrap-test-$distro-$$
  # Its own network namespace (the default bridge). Docker's and
  # containerd's stores are volumes: the inner Docker cannot put overlayfs
  # on the container's own overlayfs.
  docker run -d --name "$container" --hostname "imp-test-$distro" \
    --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    -v /var/lib/docker -v /var/lib/containerd -v "$work:/mnt/archive:ro" \
    "imp-bootstrap-test:$distro" >/dev/null
  # The bus is not up for the first moments after the start.
  local state='' i
  for i in $(seq 60); do
    state=$(in_container systemctl is-system-running --wait 2>/dev/null || true)
    [ -n "$state" ] && break
    [ "$i" = 60 ] || sleep 1
  done
  case $state in running | degraded) ;; *) fail "[$distro] systemd did not come up: $state" ;; esac
  docker cp deploy/bootstrap.sh "$container:/root/bootstrap.sh"
  if [ "$distro" = ubuntu ]; then
    in_container ufw --force enable >/dev/null
  fi

  log "[$distro] --check on the fresh host"
  if bootstrap --check; then fail "[$distro] --check found nothing to do on a fresh host"; fi
  in_container test ! -e /etc/imp || fail "[$distro] --check changed the host"

  log "[$distro] first run"
  bootstrap --yes || fail "[$distro] the first run failed"
  if [ -n "$stub" ]; then
    ! grep -qF "$fake_key" <<<"$LAST_OUTPUT" || fail "[$distro] bootstrap.sh printed the Tailscale key"
    in_container grep -qxF "TAILSCALE_AUTHKEY=$fake_key" /etc/imp/imp-host.env \
      || fail "[$distro] the Tailscale key is not in imp-host.env"
  fi
  wait_for_imp_host || fail "[$distro] the imp-host container is not running"
  in_container systemctl -q is-active imp-firewall || fail "[$distro] imp-firewall is not active"
  in_container nft list table inet imp_host >/dev/null || fail "[$distro] the firewall table is missing"
  [ "$(in_container stat -c %a /etc/imp/imp-host.env)" = 600 ] || fail "[$distro] imp-host.env is not 0600"
  if [ "$distro" = ubuntu ]; then
    in_container ufw status | grep -q 'Status: inactive' || fail "[ubuntu] ufw is still active"
  fi

  log "[$distro] --check after the first run"
  bootstrap --check || fail "[$distro] --check found pending changes after a full run"
  log "[$distro] second run"
  bootstrap --yes || fail "[$distro] the second run failed"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] the second run changed something"

  teardown
  log "[$distro] passed"
}

for distro in "${distros[@]}"; do
  run_distro "$distro"
done
log "passed: ${distros[*]}"
