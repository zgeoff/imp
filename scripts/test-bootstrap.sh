#!/bin/bash
# Run deploy/bootstrap.sh for real inside a throwaway container with systemd
# as PID 1, on Debian 13 and Ubuntu 24.04 and 26.04, and check that a second run
# changes nothing.
#
#   scripts/test-bootstrap.sh --image imp-host:<tag>   a local release image
#   scripts/test-bootstrap.sh --stub                   a stand-in image (CI)
#   scripts/test-bootstrap.sh --image ... --health     also create and exec an imp (needs KVM)
#   scripts/test-bootstrap.sh --distro debian ...      one distro only
#   scripts/test-bootstrap.sh --keep ...               leave a failed container to inspect
#   scripts/test-bootstrap.sh --zfs ...                also a real ZFS run on Ubuntu 24.04 (needs
#                                                      the zfs module loaded on this host)
#
# Each distro runs on a loop file, with --ipv6 on: CI has no IPv6 route out,
# so auto would say off. Debian also runs the IPv6 cases (a network that
# differs, accept_ra on a fake router-advert route, --ipv6 off, a client that
# takes router adverts), and --data-device on a loop device: the refusals
# first (a device with ext4, a mounted device), then --check with --storage
# zfs, then a real XFS run and --check.
#
# HOST SAFETY. The container is privileged and shares the host's kernel, so:
# - it has its own network namespace (never --network host): the firewall
#   and Docker's rules inside it never reach the host;
# - systemd-sysctl, systemd-modules-load, systemd-udevd and systemd-binfmt
#   are masked in the image, and bootstrap.sh itself writes kernel settings
#   in a container but does not apply them;
# - storage is a loop file or a loop device in the container, never a disk;
#   the EXIT trap unmounts them and detaches the loop devices (they are
#   global);
# - a ZFS pool is kernel-global too: --zfs makes one with a unique name on a
#   loop device, and the EXIT trap destroys it;
# - every run is bracketed by a snapshot of the vm.* and kernel.* sysctls
#   and the loaded modules, and the test fails on any difference.
set -euo pipefail
cd "$(dirname "$0")/.."

image=
stub=
health=
keep=
zfs=
distros=(debian ubuntu24 ubuntu26)

while [ $# -gt 0 ]; do
  case $1 in
    --image) image=${2:?--image needs a reference} && shift ;;
    --stub) stub=1 ;;
    --health) health=1 ;;
    --keep) keep=1 ;;
    --zfs) zfs=1 ;;
    --distro) distros=("${2:?--distro needs debian, ubuntu24 or ubuntu26}") && shift ;;
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
if [ -n "$zfs" ] && [ ! -r /sys/module/zfs/version ]; then
  echo "test-bootstrap: --zfs needs the zfs module loaded on this host" >&2
  exit 2
fi

work=$(mktemp -d)
container=
loop_file=/var/imp.xfs
# backing files for the --data-device leg
disk_empty=/var/disk-empty.img
disk_ext4=/var/disk-ext4.img
zfs_pool=impt$$
storage_args=()
extra_args=()

log() { echo "test-bootstrap: $*"; }
fail() {
  echo "test-bootstrap: FAIL: $*" >&2
  exit 1
}

# kernel_state: the global kernel state a container could change. Counters
# and values that move on their own are left out. Of the modules, only the
# ones bootstrap.sh would load: the kernel loads others (nft_ct, xfs, the
# socket diag modules) on demand when the container uses them.
kernel_state() {
  sysctl -a 2>/dev/null \
    | grep -E '^(vm|kernel)\.' \
    | grep -vE '^kernel\.(random\.|spl\.kmem\.|ns_last_pid|pty\.nr|sched_domain\.|perf_event_max_sample_rate|tainted)' || true
  awk '$1 ~ /^(kvm|kvm_intel|kvm_amd|tun|loop|zfs)$/ { print "module", $1 }' /proc/modules | sort
}

# teardown: stop the test container. Mounts are undone and loop devices
# detached inside it first: the loop devices are the host's, and removing
# the container would leave them attached.
teardown() {
  [ -n "$container" ] || return 0
  docker exec "$container" bash -c '
    systemctl stop imp-host 2>/dev/null
    pool=$1
    shift
    ! zpool list "$pool" >/dev/null 2>&1 || zpool destroy -f "$pool"
    for dir in /var/lib/imp /mnt/ext4; do ! mountpoint -q "$dir" || umount "$dir"; done
    for file in "$@"; do
      [ -e "$file" ] || continue
      for dev in $(losetup --list -n -O NAME -j "$file"); do losetup -d "$dev"; done
    done
  ' teardown "$zfs_pool" "$loop_file" "$disk_empty" "$disk_ext4" \
    || echo "test-bootstrap: WARNING: teardown in $container failed; check losetup -l" >&2
  docker rm -f -v "$container" >/dev/null
  container=
}

cleanup() {
  if [ -n "$keep" ] && [ -n "$container" ]; then
    echo "test-bootstrap: kept $container; unmount /var/lib/imp and detach its loop devices before docker rm -f -v" >&2
    return
  fi
  teardown
  rm -rf "$work"
}
trap cleanup EXIT

if [ -n "$stub" ]; then
  # Stands in for the release image: the unit runs it with the same flags,
  # so every phase but the health check runs as on a server. Its tailscale
  # reports Running and it saves node state, so the bootstrap's tailscale
  # phase (wait, then blank the key) runs too.
  image=imp-host-stub:test
  docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie-slim
LABEL imp.tailscale-keyless="1"
COPY --chmod=755 <<'SH' /usr/local/bin/tailscale
#!/bin/sh
echo '{"BackendState":"Running"}'
SH
COPY <<'SH' /usr/local/lib/imp/tailscale-up.sh
# stand-in: starts tailscaled from the saved node state
SH
CMD ["sh", "-c", "mkdir -p /var/lib/imp/tailscale && echo stub >/var/lib/imp/tailscale/tailscaled.state && exec sleep infinity"]
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
    ubuntu24) base=ubuntu:24.04 extra=ufw ;;
    ubuntu26) base=ubuntu:26.04 extra=ufw ;;
  esac
  docker build -q -t "imp-bootstrap-test:$distro" --build-arg BASE="$base" --build-arg EXTRA="$extra" - >/dev/null <<'EOF'
ARG BASE
FROM ${BASE}
ARG EXTRA
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server procps iproute2 ca-certificates \
      netcat-openbsd e2fsprogs ${EXTRA} \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/sbin/policy-rc.d
# policy-rc.d (removed above) stops services from starting on install in a
# Docker image; a server has none. The masked units write kernel-global
# state (sysctls, modules, binfmt) or touch host devices, and the container
# shares the host's kernel.
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
  local args=("$mode" "${storage_args[@]}" "${extra_args[@]}" --image "$image" --image-archive /mnt/archive/image.tar)
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
  # a change that failed, such as a restart of imp-host: show why
  if [ "$rc" = 1 ] && grep -q '^bootstrap: failed: ' <<<"$out"; then
    in_container journalctl -u imp-host --no-pager -n 40 >&2 || true
  fi
  return "$rc"
}

# expect_exit WANT MODE: run bootstrap.sh in MODE and fail unless it exits
# WANT (--check: 0 nothing pending, 2 changes pending, 1 an error).
expect_exit() {
  local want=$1 rc=0
  shift
  bootstrap "$@" || rc=$?
  [ "$rc" = "$want" ] || fail "bootstrap.sh $* exited $rc, not $want"
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

# start_container DISTRO: a fresh systemd container, booted.
start_container() {
  local distro=$1
  log "[$distro] building the systemd image"
  build_image "$distro"
  container=imp-bootstrap-test-$distro-$$
  # Its own network namespace (the default bridge). Docker's and
  # containerd's stores are volumes: the inner Docker cannot put overlayfs
  # on the container's own overlayfs. Docker turns IPv6 off in a container
  # on an IPv4-only network; the inner Docker's IPv6 network needs it on.
  docker run -d --name "$container" --hostname "imp-test-$distro" \
    --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    --sysctl net.ipv6.conf.all.disable_ipv6=0 --sysctl net.ipv6.conf.default.disable_ipv6=0 \
    -v /var/lib/docker -v /var/lib/containerd -v "$work:/mnt/archive:ro" \
    "imp-bootstrap-test:$distro" >/dev/null
  # The bus is not up for the first moments, and "offline" comes before init runs.
  local state='' i
  for i in $(seq 60); do
    state=$(in_container systemctl is-system-running --wait 2>/dev/null || true)
    case $state in running | degraded) break ;; esac
    [ "$i" = 60 ] || sleep 1
  done
  case $state in running | degraded) ;; *) fail "[$distro] systemd did not come up: $state" ;; esac
  docker cp deploy/bootstrap.sh "$container:/root/bootstrap.sh"
}

can_connect() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# check_firewall_drops: from the host, SSH connects and another listening
# port does not.
check_firewall_drops() {
  local ip
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container")
  docker exec -d "$container" nc -lk 9999
  sleep 1
  can_connect "$ip" 22 || fail "SSH on $ip:22 does not connect"
  if can_connect "$ip" 9999; then
    fail "port 9999 on $ip connects through the firewall"
  fi
}

# check_host_firewall_none: --host-firewall none takes out the imp table and
# its unit, a later run keeps none, and a table that comes back is drift.
check_host_firewall_none() {
  log "[$distro] --host-firewall none"
  extra_args=(--host-firewall none)
  expect_exit 2 --check
  grep -qF "would: remove imp-firewall.service and the inet imp_host table" <<<"$LAST_OUTPUT" \
    || fail "[$distro] --check did not plan the firewall's removal"
  bootstrap --yes || fail "[$distro] the run with --host-firewall none failed"
  in_container test ! -e /etc/systemd/system/imp-firewall.service || fail "[$distro] imp-firewall.service is left"
  in_container test ! -e /etc/imp/firewall.nft || fail "[$distro] /etc/imp/firewall.nft is left"
  ! in_container nft list table inet imp_host >/dev/null 2>&1 || fail "[$distro] the inet imp_host table is left"
  ! in_container nft list ruleset | grep -qE 'hook input .*policy drop' \
    || fail "[$distro] an input chain with policy drop is left"
  in_container grep -qx IMP_HOST_FIREWALL=none /etc/imp/imp-host.env || fail "[$distro] the env file does not say none"
  wait_for_imp_host || fail "[$distro] imp-host is not running with --host-firewall none"
  log "[$distro] --host-firewall none again changes nothing"
  bootstrap --yes || fail "[$distro] the second run with --host-firewall none failed"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] --host-firewall none is not idempotent"

  extra_args=()
  log "[$distro] the env file keeps none"
  expect_exit 0 --check
  log "[$distro] a table that comes back is drift, and --yes refuses it"
  in_container nft add table inet imp_host
  expect_exit 2 --check
  expect_exit 1 --yes
  grep -qF "run with --host-firewall none to remove it" <<<"$LAST_OUTPUT" || fail "[$distro] no hint for the drift"
  in_container nft delete table inet imp_host
}

# imp_host_ip6 ARGS...: ip -6 ARGS in imp-host's network namespace; the
# stub has no ip.
imp_host_ip6() {
  local pid
  pid=$(in_container docker inspect -f '{{.State.Pid}}' imp-host)
  in_container nsenter -t "$pid" -n ip -6 "$@"
}

# imp_host_networks: the networks imp-host is on, one per line.
imp_host_networks() { in_container docker inspect -f '{{json .NetworkSettings.Networks}}' imp-host | jq -r 'keys[]'; }

env_value() { in_container sed -n "s/^$1=//p" /etc/imp/imp-host.env | tail -n 1; }

# check_ipv6_on: imp-host runs on the IPv6 network the env file names, and
# has an IPv6 default route.
check_ipv6_on() {
  local subnet route
  subnet=$(env_value IMP_HOST_SUBNET6)
  [ -n "$subnet" ] || fail "[$distro] the env file has no IMP_HOST_SUBNET6"
  [ "$(env_value IMP_HOST_IPV6)" = on ] || fail "[$distro] the env file does not say IMP_HOST_IPV6=on"
  [ "$(env_value IMP_HOST_NETWORK)" = "--network imp-host" ] || fail "[$distro] IMP_HOST_NETWORK does not name imp-host"
  [ "$(in_container docker network inspect -f '{{.EnableIPv6}} {{index .Options "com.docker.network.bridge.name"}}' imp-host)" = "true br-imphost" ] \
    || fail "[$distro] the imp-host network is not IPv6 on br-imphost"
  in_container docker network inspect -f '{{range .IPAM.Config}} {{.Subnet}}{{end}} ' imp-host | grep -qF " $subnet " \
    || fail "[$distro] the imp-host network is not on $subnet"
  [ "$(imp_host_networks)" = imp-host ] \
    || fail "[$distro] the imp-host container is not on the imp-host network alone"
  route=$(imp_host_ip6 route show default)
  [ -n "$route" ] || fail "[$distro] imp-host has no IPv6 default route"
  log "[$distro] imp-host's IPv6 default route: $route"
}

# check_imp_egress6: with the real image, an imp reaches an IPv6 address
# outside the host container: SSH on a dummy interface of the test
# container, through impd's NAT66 and the imp-host network. 2001:db8::/32 is
# not among impd's blocked ranges.
check_imp_egress6() {
  local target=2001:db8:ffff::1 name=egress6
  log "[$distro] an imp reaches $target over IPv6"
  in_container ip link add imptarget type dummy
  in_container ip link set imptarget up
  in_container ip -6 addr add "$target/128" dev imptarget nodad
  in_container docker exec imp-host imp rm "$name" >/dev/null 2>&1 || true
  in_container docker exec imp-host imp new "$name" --image ubuntu --memory 512m >/dev/null
  in_container docker exec imp-host imp exec "$name" -- timeout 10 bash -c "exec 3<>/dev/tcp/$target/22" \
    || fail "[$distro] the imp cannot reach $target:22 over IPv6"
  in_container docker exec imp-host imp rm "$name" >/dev/null
  in_container ip link del imptarget
}

# check_ipv6_cases: a network that differs is recreated; accept_ra=2 on a
# dotted uplink whose default route the kernel took from router adverts;
# --ipv6 off undoes both; a client that takes router adverts stops the run
# that would turn IPv6 on, unless --ra-handled.
check_ipv6_cases() {
  local subnet fake=eth9.7
  subnet=$(env_value IMP_HOST_SUBNET6)

  log "[$distro] ipv6: a network with another subnet is drift, and a run recreates it"
  in_container systemctl stop imp-host
  in_container docker network rm imp-host >/dev/null
  in_container docker network create --ipv6 --subnet fd00:dead:beef::/64 \
    -o com.docker.network.bridge.name=br-imphost imp-host >/dev/null
  expect_exit 2 --check
  grep -qF "would: recreate the imp-host network (its IPv6 subnet is fd00:dead:beef::/64, not $subnet)" <<<"$LAST_OUTPUT" \
    || fail "[$distro] --check did not plan to recreate the network"
  bootstrap --yes || fail "[$distro] the run that recreates the network failed"
  wait_for_imp_host || fail "[$distro] imp-host is not running on the recreated network"
  check_ipv6_on

  log "[$distro] ipv6: a router-advert route the kernel takes gets accept_ra=2, on a dotted name"
  in_container ip link add "$fake" type dummy
  in_container ip link set "$fake" up
  in_container ip -6 addr add 2001:db8:ffff::2/64 dev "$fake" nodad
  in_container ip -6 route add default via 2001:db8:ffff::1 dev "$fake" proto ra
  in_container sysctl -qw "net/ipv6/conf/$fake/accept_ra=1"
  expect_exit 2 --check
  grep -qF "would: sysctl net/ipv6/conf/$fake/accept_ra=2" <<<"$LAST_OUTPUT" || fail "[$distro] --check did not plan accept_ra=2"
  bootstrap --yes || fail "[$distro] the accept_ra run failed"
  in_container grep -qx "net/ipv6/conf/$fake/accept_ra = 2" /etc/sysctl.d/90-imp-ipv6.conf \
    || fail "[$distro] the accept_ra file does not name $fake"
  [ "$(in_container cat "/proc/sys/net/ipv6/conf/$fake/accept_ra")" = 2 ] || fail "[$distro] accept_ra is not 2"
  bootstrap --yes || fail "[$distro] the second accept_ra run failed"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] accept_ra is not idempotent"
  extra_args=(--ipv6 auto)
  expect_exit 0 --check
  grep -qF "ipv6: on (auto: $fake has a global IPv6 default route)" <<<"$LAST_OUTPUT" || fail "[$distro] auto did not see $fake"

  log "[$distro] ipv6: --ipv6 off removes the network and the accept_ra file"
  extra_args=(--ipv6 off)
  expect_exit 2 --check
  grep -qF "would: stop imp-host and remove the imp-host network" <<<"$LAST_OUTPUT" || fail "[$distro] --check did not plan the removal"
  bootstrap --yes || fail "[$distro] the --ipv6 off run failed"
  ! in_container docker network inspect imp-host >/dev/null 2>&1 || fail "[$distro] the imp-host network is left"
  in_container test ! -e /etc/sysctl.d/90-imp-ipv6.conf || fail "[$distro] the accept_ra file is left"
  [ "$(env_value IMP_HOST_IPV6)" = off ] && [ -z "$(env_value IMP_HOST_NETWORK)" ] || fail "[$distro] the env file is not off"
  [ "$(env_value IMP_HOST_SUBNET6)" = "$subnet" ] || fail "[$distro] off dropped the subnet"
  wait_for_imp_host || fail "[$distro] imp-host is not running with --ipv6 off"
  [ "$(imp_host_networks)" = bridge ] \
    || fail "[$distro] imp-host is not on the default bridge"
  extra_args=()
  bootstrap --yes || fail "[$distro] the second off run failed"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] off is not idempotent"
  log "[$distro] ipv6: a network that comes back is drift, and --yes refuses it"
  in_container docker network create imp-host >/dev/null
  expect_exit 2 --check
  expect_exit 1 --yes
  grep -qF "run with --ipv6 off to remove them" <<<"$LAST_OUTPUT" || fail "[$distro] no hint for the drift"
  in_container docker network rm imp-host >/dev/null

  log "[$distro] ipv6: a client that takes router adverts stops on, unless --ra-handled"
  in_container sysctl -qw "net/ipv6/conf/$fake/accept_ra=0"
  extra_args=(--ipv6 on)
  expect_exit 1 --check
  grep -qF "the IPv6 default route on $fake comes from router adverts that a client other than the kernel takes" <<<"$LAST_OUTPUT" \
    || fail "[$distro] no refusal for router adverts outside the kernel"
  extra_args=(--ipv6 on --ra-handled)
  bootstrap --yes || fail "[$distro] the --ra-handled run failed"
  wait_for_imp_host || fail "[$distro] imp-host is not running after --ra-handled"
  check_ipv6_on
  extra_args=()
  bootstrap --yes || fail "[$distro] the run after --ra-handled failed"
  grep -qF "IPv6 was on already" <<<"$LAST_OUTPUT" || fail "[$distro] a later run did not accept the network"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] the run after --ra-handled changed something"

  log "[$distro] ipv6: an older host whose adverts a client takes re-runs into auto, which warns and stays off"
  make_old_host
  in_container sysctl -qw "net/ipv6/conf/$fake/accept_ra=0"
  bootstrap --yes || fail "[$distro] the re-run of an older host failed"
  grep -qF "WARNING: the IPv6 default route on $fake comes from router adverts" <<<"$LAST_OUTPUT" \
    || fail "[$distro] auto did not warn about the router adverts"
  [ "$(env_value IMP_HOST_IPV6)" = off ] || fail "[$distro] auto did not record off"
  wait_for_imp_host || fail "[$distro] imp-host is not running after the re-run"
  [ "$(imp_host_networks)" = bridge ] || fail "[$distro] imp-host left the default bridge"

  log "[$distro] ipv6: an older host whose adverts the kernel takes re-runs into auto, which turns IPv6 on"
  make_old_host
  in_container sysctl -qw "net/ipv6/conf/$fake/accept_ra=1"
  bootstrap --yes || fail "[$distro] the re-run of an older host failed"
  grep -qF "ipv6: on (auto: $fake has a global IPv6 default route)" <<<"$LAST_OUTPUT" || fail "[$distro] auto did not turn on"
  wait_for_imp_host || fail "[$distro] imp-host is not running after the re-run"
  check_ipv6_on
  in_container ip link del "$fake"
}

# make_old_host: the host as a bootstrap.sh before IPv6 left it: imp-host
# on the default bridge, and no IPv6 keys in the env file or the unit.
make_old_host() {
  extra_args=(--ipv6 off)
  bootstrap --yes || fail "[$distro] the --ipv6 off run before an older host failed"
  extra_args=()
  in_container sed -i '/^IMP_HOST_\(IPV6\|SUBNET6\|NETWORK\)=/d' /etc/imp/imp-host.env
  in_container sed -i '/IMP_HOST_NETWORK/d' /etc/systemd/system/imp-host.service
  in_container systemctl daemon-reload
  in_container systemctl restart imp-host
  wait_for_imp_host || fail "[$distro] imp-host is not running as an older host"
}

run_distro() {
  local distro=$1
  start_container "$distro"
  storage_args=(--loop-file "$loop_file" --loop-size 50)
  if [[ $distro == ubuntu* ]]; then
    in_container ufw --force enable >/dev/null
  fi

  # Ubuntu ships the zfs module with its kernel: no contrib, no dkms.
  if [ "$distro" = ubuntu26 ]; then
    log "[$distro] --storage zfs --check on an empty device"
    local dev want
    dev=$(in_container bash -c "truncate -s 20G $disk_empty && losetup -f --show $disk_empty")
    storage_args=(--storage zfs --data-device "$dev")
    expect_exit 2 --check
    for want in "would: apt-get install zfsutils-linux" "would: zpool create tank on $dev" \
      "would: zfs create tank/imp (mountpoint=legacy)" "would: write /etc/modprobe.d/imp-zfs.conf"; do
      grep -qF "$want" <<<"$LAST_OUTPUT" || fail "[$distro] --check with zfs did not plan: $want"
    done
    ! grep -qE 'zfs-dkms|linux-headers|contrib' <<<"$LAST_OUTPUT" || fail "[$distro] zfs on Ubuntu planned dkms"
    in_container losetup -d "$dev"
    storage_args=(--loop-file "$loop_file" --loop-size 50)
  fi

  log "[$distro] --check on the fresh host"
  extra_args=(--ipv6 on)
  expect_exit 2 --check
  in_container test ! -e /etc/imp || fail "[$distro] --check changed the host"
  grep -qF "would: create the imp-host network" <<<"$LAST_OUTPUT" || fail "[$distro] --check did not plan the network"

  log "[$distro] first run"
  bootstrap --yes || fail "[$distro] the first run failed"
  # later runs keep on from the env file
  extra_args=()
  if [ -n "$stub" ]; then
    ! grep -qF "$fake_key" <<<"$LAST_OUTPUT" || fail "[$distro] bootstrap.sh printed the Tailscale key"
    grep -q 'change: blank TAILSCALE_AUTHKEY' <<<"$LAST_OUTPUT" || fail "[$distro] the key was not blanked"
    in_container grep -qx "TAILSCALE_AUTHKEY=" /etc/imp/imp-host.env \
      || fail "[$distro] imp-host.env still holds a Tailscale key"
    ! in_container docker inspect -f '{{.Config.Env}}' imp-host | grep -qF "$fake_key" \
      || fail "[$distro] the running imp-host still has the Tailscale key in its environment"
    grep -q "delete /mnt/archive/authkey now" <<<"$LAST_OUTPUT" || fail "[$distro] no reminder to delete the key file"
  fi
  wait_for_imp_host || fail "[$distro] the imp-host container is not running"
  in_container systemctl -q is-active imp-firewall || fail "[$distro] imp-firewall is not active"
  in_container nft list table inet imp_host >/dev/null || fail "[$distro] the firewall table is missing"
  [ "$(in_container stat -c %a /etc/imp/imp-host.env)" = 600 ] || fail "[$distro] imp-host.env is not 0600"
  if [[ $distro == ubuntu* ]]; then
    in_container ufw status | grep -q 'Status: inactive' || fail "[$distro] ufw is still active"
  fi
  check_firewall_drops
  check_ipv6_on
  [ -z "$health" ] || check_imp_egress6

  log "[$distro] --check after the first run"
  expect_exit 0 --check
  log "[$distro] second run"
  bootstrap --yes || fail "[$distro] the second run failed"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] the second run changed something"

  check_host_firewall_none
  [ "$distro" != debian ] || check_ipv6_cases

  teardown
  log "[$distro] passed"
}

# run_device: --data-device on loop devices. The health check is skipped;
# the loop-file runs cover it.
run_device() {
  local distro=debian empty ext4
  start_container "$distro"
  empty=$(in_container bash -c "truncate -s 20G $disk_empty && losetup -f --show $disk_empty")
  ext4=$(in_container bash -c "truncate -s 1G $disk_ext4 && mkfs.ext4 -q $disk_ext4 && losetup -f --show $disk_ext4")
  local saved_health=$health
  health=

  log "[$distro] --data-device refuses a device with ext4"
  storage_args=(--data-device "$ext4")
  expect_exit 1 --check
  grep -q "holds ext4" <<<"$LAST_OUTPUT" || fail "[$distro] no 'holds ext4' refusal"

  log "[$distro] --data-device refuses a mounted device"
  in_container bash -c "mkdir -p /mnt/ext4 && mount $ext4 /mnt/ext4"
  expect_exit 1 --check
  grep -q "is mounted" <<<"$LAST_OUTPUT" || fail "[$distro] no 'is mounted' refusal"

  log "[$distro] --check sizes a loop file from the free space"
  storage_args=(--loop-file /var/auto.xfs)
  expect_exit 2 --check
  grep -qE "GiB free on /; the loop file gets [0-9]+ GiB" <<<"$LAST_OUTPUT" \
    || fail "[$distro] --check did not size the loop file"

  log "[$distro] --storage zfs --check on an empty device"
  storage_args=(--storage zfs --data-device "$empty")
  expect_exit 2 --check
  local want
  for want in "would: apt-get install linux-headers-" "would: zpool create tank on $empty" \
    "would: zfs create tank/imp (mountpoint=legacy)" "would: write /etc/modprobe.d/imp-zfs.conf"; do
    grep -qF "$want" <<<"$LAST_OUTPUT" || fail "[$distro] --check with zfs did not plan: $want"
  done

  log "[$distro] --data-device on an empty device"
  storage_args=(--data-device "$empty")
  bootstrap --yes || fail "[$distro] the --data-device run failed"
  grep -qF "ipv6: off (auto: the host has no global IPv6 default route)" <<<"$LAST_OUTPUT" \
    || fail "[$distro] auto did not turn IPv6 off on a host without an IPv6 route"
  in_container grep -qE '^UUID=[0-9a-f-]+ /var/lib/imp xfs defaults,nofail 0 2$' /etc/fstab \
    || fail "[$distro] /etc/fstab has no UUID entry for /var/lib/imp"
  expect_exit 0 --check

  log "[$distro] --storage zfs refuses an XFS host whose mount is down"
  in_container umount /var/lib/imp
  storage_args=(--storage zfs --data-device "$ext4")
  expect_exit 1 --check
  grep -q "/etc/fstab has an entry for /var/lib/imp" <<<"$LAST_OUTPUT" || fail "[$distro] no fstab refusal"

  health=$saved_health
  teardown
  log "[$distro] --data-device passed"
}

# run_zfs: --storage zfs on a loop device, for real: a pool, the dataset,
# imp-host on it, then --check and a second run.
run_zfs() {
  local distro=ubuntu24 dev
  start_container "$distro"
  dev=$(in_container bash -c "truncate -s 20G $disk_empty && losetup -f --show $disk_empty")
  storage_args=(--storage zfs --zfs-pool "$zfs_pool" --data-device "$dev")

  log "[$distro] zfs: first run"
  bootstrap --yes || fail "[$distro] the zfs run failed"
  in_container zfs get -H -o value mountpoint "$zfs_pool/imp" | grep -qx legacy \
    || fail "[$distro] $zfs_pool/imp is not mountpoint=legacy"
  in_container grep -qx 'IMP_STORAGE_BACKEND=zfs' /etc/imp/imp-host.env || fail "[$distro] the env file is not zfs"
  in_container grep -qx "IMP_ZFS_ROOT=$zfs_pool/imp" /etc/imp/imp-host.env || fail "[$distro] no IMP_ZFS_ROOT"
  wait_for_imp_host || fail "[$distro] the imp-host container is not running on zfs"

  log "[$distro] zfs: --check and a second run"
  expect_exit 0 --check
  bootstrap --yes || fail "[$distro] the second zfs run failed"
  grep -q 'bootstrap: 0 change(s) made' <<<"$LAST_OUTPUT" || fail "[$distro] the second zfs run changed something"

  teardown
  log "[$distro] zfs passed"
}

for distro in "${distros[@]}"; do
  run_distro "$distro"
  [ "$distro" != debian ] || run_device
done
[ -z "$zfs" ] || run_zfs
log "passed: ${distros[*]}"
