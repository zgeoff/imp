#!/bin/bash
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
# it embeds deploy/imp-host.service, deploy/imp-docker-proxy.service and
# deploy/imp-host.env.example (a test keeps the copies equal to those files).
#
# The Tailscale key comes from --tailscale-authkey-file or TAILSCALE_AUTHKEY
# and goes only to /etc/imp/imp-host.env (0600). It is never printed and
# never put in argv. Never run this script with `bash -x`.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--yes | --dry-run | --check] STORAGE [options]

Modes (one):
  --yes                       make the changes
  --dry-run                   print the changes, make none
  --check                     like --dry-run; exit 2 if any change is pending

Exit status: 0 done (or nothing pending), 1 an error or a refusal, 2 --check
found changes pending.

Storage:
  --storage xfs|zfs           the backend (default: the env file's, else xfs)
  --data-device DEV           an empty disk or partition for imp: XFS with
                              reflink on /var/lib/imp, or a ZFS pool. A device
                              with another signature, partitions or mounts is
                              refused.
  --loop-file PATH            XFS only: a sparse XFS file on the root
                              filesystem instead of a device
  --loop-size GIB|auto        its size (default auto: the free space on /
                              less what the OS and Docker keep)
  --zfs-pool NAME             ZFS only: the pool (default tank). It is created
                              on --data-device, or must exist already; imp
                              gets the dataset NAME/imp.

Options:
  --image REF                 host image, pinned in the env file (default: the
                              image of this script's release)
  --image-archive FILE        docker load FILE when REF is missing, instead of a pull
  --tailscale-authkey-file F  a tagged auth key for the host container's node
                              (or TAILSCALE_AUTHKEY in the environment)
  --host-firewall own|none    own (default): an nft table admits SSH only;
                              none: the platform owns the inbound firewall,
                              and a table loaded by an earlier run is removed
  --ssh-port N                one more SSH port to keep open (repeatable)
  --ipv6 auto|on|off          imps' IPv6: on runs imp-host on a Docker network
                              with IPv6, behind Docker's NAT66; auto (the
                              first run's default) is on when the host has a
                              global IPv6 default route. Later runs keep the
                              env file's choice. off removes the network.
  --ra-handled                the client that takes the host's router adverts
                              (networkd, NetworkManager, dhcpcd) keeps them
                              with forwarding on; see docs/guides/install.md#ipv6
  --ksm                       let KSM merge identical guest pages: ksmd runs
                              at boot and IMP_KSM=1. Linux 6.10 or later, not
                              in a container. Off by default: merged pages let
                              guests time each other (docs/architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages).
  --no-ksm                    turn it off again: remove the boot rule, stop
                              ksmd, unmerge its pages and set IMP_KSM=0;
                              running imps keep the merge flag until they
                              restart
  --skip-health               skip the closing health check
EOF
}

readonly IMP_DIR=/etc/imp
readonly ENV_FILE=$IMP_DIR/imp-host.env
readonly FIREWALL_FILE=$IMP_DIR/firewall.nft
readonly SECCOMP_FILE=$IMP_DIR/imp-host.seccomp.json
readonly SECCOMP_IN_IMAGE=/usr/local/share/imp/deploy/imp-host.seccomp.json
readonly DATA_DIR=/var/lib/imp
# The image of this script's release, as the units name it; release-please
# bumps it.
readonly DEFAULT_IMAGE=ghcr.io/zgeoff/imp-host:0.40.4 # x-release-please-version
# The image line every env file had before the units named their release.
# A file still holding it gets the commented pin; any other value is the
# operator's pin and stays.
readonly LEGACY_IMAGE_LINE=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest
# Docker's apt signing key (https://docs.docker.com/engine/install/ubuntu/).
readonly DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# The template's IMP_RAM_BUDGET_MIB; a file still holding it gets the
# computed budget, any other value is the operator's and stays.
readonly TEMPLATE_BUDGET_MIB=16384
# A computed RAM budget below this is refused: the host is too small for the
# formula, and the operator sets IMP_RAM_BUDGET_MIB.
readonly RAM_BUDGET_FLOOR_MIB=512
# A loop file smaller than this is refused.
readonly LOOP_MIN_GIB=20
# With IPv6, imp-host runs on this Docker network. The bridge has a fixed
# name so a host firewall can admit it; the name keeps clear of imp's own
# interfaces (imp0, imp+).
readonly HOST_NETWORK=imp-host
readonly HOST_BRIDGE=br-imphost
# accept_ra=2 for the uplink, when the kernel takes its router adverts.
readonly RA_FILE=/etc/sysctl.d/90-imp-ipv6.conf
# docker network inspect: IPv6 on, the bridge's name, then every subnet.
readonly NETWORK_FORMAT='{{.EnableIPv6}} {{or (index .Options "com.docker.network.bridge.name") "unnamed"}}{{range .IPAM.Config}} {{.Subnet}}{{end}}'

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

write_file() {
  local path=$1 perm=$2 content=$3 tmp
  mkdir -p "$(dirname "$path")" || return 1
  tmp=$(mktemp "$path.XXXXXX") || return 1
  if ! { chmod "$perm" "$tmp" && printf '%s\n' "$content" >"$tmp" && mv "$tmp" "$path"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# --- pure helpers (deploy/bootstrap.test.ts covers them) ---

# version_ge A B: A >= B for dotted versions.
version_ge() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$2" ]
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

# ram_budget_mib MEMTOTAL_KIB [ARC_MIB]: the RAM awake imps may use. The
# host keeps the larger of 8 GiB and 15 % for itself, Docker, impd and the
# page cache, and with ZFS also the ARC's cap.
ram_budget_mib() {
  local total=$(($1 / 1024)) arc=${2:-0} reserve
  reserve=$((total * 15 / 100))
  [ "$reserve" -lt 8192 ] && reserve=8192
  echo $((total - reserve - arc))
}

# check_ram_budget BUDGET MEMTOTAL_KIB ARC_MIB SETTING: fail, saying why,
# when a computed budget is below the floor. SETTING names what the operator
# sets instead.
check_ram_budget() {
  local budget=$1 total=$(($2 / 1024)) arc=$3
  [ "$budget" -ge "$RAM_BUDGET_FLOOR_MIB" ] && return 0
  echo "the RAM budget for awake imps comes out at ${budget} MiB, below the ${RAM_BUDGET_FLOOR_MIB} MiB floor:" \
    "RAM ${total} MiB, less the larger of 8192 MiB and 15 %, less the ZFS ARC cap ${arc} MiB." \
    "Set $4 to what imps may use on this host" >&2
  return 1
}

# zfs_arc_max_mib MEMTOTAL_KIB: the cap on the ZFS ARC, 10 % of RAM within
# 1 to 8 GiB. Uncapped, the ARC grows to half of RAM, and the governor does
# not see what it takes from the guests.
zfs_arc_max_mib() {
  local arc=$(($1 / 1024 / 10))
  [ "$arc" -lt 1024 ] && arc=1024
  [ "$arc" -gt 8192 ] && arc=8192
  echo "$arc"
}

# mkfs_xfs_opts KERNEL XFSPROGS: the mkfs.xfs options for an XFS this kernel
# can mount. Each feature is turned off only when xfsprogs knows the option
# (an older mkfs.xfs rejects it) and the kernel cannot mount it.
mkfs_xfs_opts() {
  local kernel=$1 progs=$2 inode=()
  local opts=(-m reflink=1)
  if version_ge "$progs" 5.19 && ! version_ge "$kernel" 5.19; then
    inode+=(nrext64=0)
  fi
  if version_ge "$progs" 6.13 && ! version_ge "$kernel" 6.10; then
    inode+=(exchange=0)
  fi
  if [ ${#inode[@]} -gt 0 ]; then
    opts+=(-i "$(
      IFS=,
      echo "${inode[*]}"
    )")
  fi
  if version_ge "$progs" 6.13 && ! version_ge "$kernel" 6.12; then
    opts+=(-n parent=0)
  fi
  echo "${opts[*]}"
}

# loop_size_auto_gib AVAIL_GIB: the loop file's size from the free space on
# /. The OS, Docker's images and logs keep the larger of 30 GiB and 15 %;
# the file is sparse, but it must never grow into that and fill /.
loop_size_auto_gib() { echo $(($1 - $(loop_reserve_gib "$1"))); }

# loop_reserve_gib AVAIL_GIB: what / keeps for the OS when a loop file is
# on it.
loop_reserve_gib() {
  local keep=$(($1 * 15 / 100))
  [ "$keep" -lt 30 ] && keep=30
  echo "$keep"
}

# fstab_line SOURCE KIND: the /etc/fstab entry for /var/lib/imp. nofail: a
# missing disk must not stop the boot; the host container then refuses to
# start, because nothing is mounted. nosuid: the host never honors a setuid
# bit or a file capability from an image's files.
fstab_line() {
  case $2 in
    device) printf '%s %s xfs defaults,nosuid,nofail 0 2\n' "$1" "$DATA_DIR" ;;
    loop) printf '%s %s xfs loop,nosuid,nofail 0 0\n' "$1" "$DATA_DIR" ;;
  esac
}

# fstab_entry_state FSTAB LINE: none when FSTAB has no entry for
# /var/lib/imp, same when it has LINE, old when it has LINE as a bootstrap
# before nosuid wrote it, other for anything else.
fstab_entry_state() {
  if ! grep -qE "^[^#]*[[:space:]]${DATA_DIR}[[:space:]]" "$1"; then
    echo none
  elif grep -qxF "$2" "$1"; then
    echo same
  elif grep -qxF "${2/,nosuid/}" "$1"; then
    echo old
  else
    echo other
  fi
}

# ssh_ports_from_sshd_t: ports from `sshd -T` output on stdin.
ssh_ports_from_sshd_t() { awk 'tolower($1) == "port" { print $2 }'; }

# ssh_ports_from_listen: ports from systemd socket Listen= values or `ss`
# local addresses on stdin, such as "[::]:22 (Stream)" or "0.0.0.0:2222".
ssh_ports_from_listen() { grep -oE ':[0-9]+( |$)' | tr -d ': '; }

# route_uplink ROUTE: the device of an `ip -6 route` line, or nothing.
route_uplink() { awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }' <<<"$1"; }

# route_is_ra ROUTE: the route came from a router advert.
route_is_ra() { [[ " $1 " == *" proto ra "* ]]; }

# ipv6_expand ADDR: the eight groups of an IPv6 address, colon-separated,
# lower case and without leading zeros; fails on anything else.
ipv6_expand() {
  local addr=${1,,} i
  local -a groups=() head=() tail=()
  if [[ $addr == *::* ]]; then
    [[ ${addr#*::} != *::* ]] || return 1
    [ -z "${addr%%::*}" ] || IFS=: read -ra head <<<"${addr%%::*}"
    [ -z "${addr#*::}" ] || IFS=: read -ra tail <<<"${addr#*::}"
    groups=("${head[@]}")
    for ((i = ${#head[@]} + ${#tail[@]}; i < 8; i++)); do groups+=(0); done
    groups+=("${tail[@]}")
  else
    IFS=: read -ra groups <<<"$addr"
  fi
  [ ${#groups[@]} = 8 ] || return 1
  for i in "${!groups[@]}"; do
    [[ ${groups[i]} =~ ^[0-9a-f]{1,4}$ ]] || return 1
    groups[i]=$(printf '%x' "0x${groups[i]}")
  done
  (
    IFS=:
    echo "${groups[*]}"
  )
}

# ipv6_canon ADDR[/LEN]: ADDR as Docker prints it (RFC 5952): lower case,
# no leading zeros, and the longest run of two or more zero groups as ::.
ipv6_canon() {
  local expanded suffix="" i
  [[ $1 == */* ]] && suffix=/${1#*/}
  expanded=$(ipv6_expand "${1%%/*}") || return 1
  local -a groups
  IFS=: read -ra groups <<<"$expanded"
  local best=-1 best_len=1 run=0 start=0
  for i in "${!groups[@]}"; do
    if [ "${groups[i]}" = 0 ]; then
      [ "$run" -gt 0 ] || start=$i
      run=$((run + 1))
      if [ "$run" -gt "$best_len" ]; then
        best=$start best_len=$run
      fi
    else
      run=0
    fi
  done
  if [ "$best" -lt 0 ]; then
    echo "$expanded$suffix"
    return
  fi
  local left right
  left=$(
    IFS=:
    echo "${groups[*]:0:best}"
  )
  right=$(
    IFS=:
    echo "${groups[*]:best+best_len}"
  )
  echo "$left::$right$suffix"
}

# subnet6 TEXT: TEXT as a canonical IPv6 /64 with no host bits; fails on
# anything else.
subnet6() {
  local expanded
  [[ $1 == */64 ]] || return 1
  expanded=$(ipv6_expand "${1%/64}") || return 1
  [[ $expanded == *:*:*:*:0:0:0:0 ]] || return 1
  ipv6_canon "$1"
}

# random_ula64: a random unique local /64 (RFC 4193): fd, a 40-bit global
# ID and subnet 0.
random_ula64() {
  local hex
  hex=$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')
  ipv6_canon "fd${hex:0:2}:${hex:2:4}:${hex:6:4}::/64"
}

# network_drift WANT INSPECT: how a network that docker network inspect
# (NETWORK_FORMAT) describes as INSPECT differs from IPv6 on the /64 WANT
# with the bridge HOST_BRIDGE; nothing when it matches.
network_drift() {
  local want=$1 enabled bridge subnet found="" have=()
  read -r enabled bridge subnet <<<"$2"
  if [ "$enabled" != true ]; then
    echo "it has no IPv6"
    return
  fi
  if [ "$bridge" != "$HOST_BRIDGE" ]; then
    echo "its bridge is $bridge, not $HOST_BRIDGE"
    return
  fi
  for subnet in $subnet; do
    [[ $subnet == *:* ]] || continue
    have+=("$subnet")
    [ "$(ipv6_canon "$subnet")" != "$want" ] || found=1
  done
  [ -n "$found" ] || echo "its IPv6 subnet is ${have[*]:-none}, not $want"
}

# network_subnet6 INSPECT: the IPv6 subnet of a network with IPv6 and the
# bridge HOST_BRIDGE, or nothing.
network_subnet6() {
  local enabled bridge subnets subnet
  read -r enabled bridge subnets <<<"$1"
  [ "$enabled" = true ] && [ "$bridge" = "$HOST_BRIDGE" ] || return 0
  for subnet in $subnets; do
    if [[ $subnet == *:* ]]; then
      ipv6_canon "$subnet"
      return
    fi
  done
}

# render_ra_file UPLINK: the sysctl.d file. The key's slash form keeps a
# dotted interface name (eth0.100) whole.
render_ra_file() {
  printf '%s\n' "# Written by deploy/bootstrap.sh (docs/guides/install.md#ipv6). Docker turns on" \
    "# IPv6 forwarding for imp-host's network; with forwarding on, the kernel" \
    "# takes router adverts on $1 only with accept_ra=2." \
    "net/ipv6/conf/$1/accept_ra = 2"
}

# ra_file_uplink: the uplink a RA_FILE on stdin names, or nothing.
ra_file_uplink() { sed -n 's|^net/ipv6/conf/\(.*\)/accept_ra = 2$|\1|p' | tail -n 1; }

# render_firewall PORT...: the nft ruleset. One transaction: create the
# table, delete it, create it again, so a reload replaces only our rules and
# never Docker's. Input only; Docker owns forwarding. The host itself is not
# a tailnet node (the host container is, and its traffic is forwarded), so no
# Tailscale port is open.
render_firewall() {
  local ports
  ports=$(printf '%s\n' "$@" | sort -nu | paste -sd, - | sed 's/,/, /g')
  cat <<EOF
# imp host firewall, written by deploy/bootstrap.sh. Loaded by
# imp-firewall.service. Inbound: SSH only.
table inet imp_host
delete table inet imp_host
table inet imp_host {
	chain input {
		type filter hook input priority filter; policy drop;
		iif "lo" accept
		ct state established,related accept
		ct state invalid drop
		meta l4proto icmp accept
		meta l4proto ipv6-icmp accept
		udp dport 68 accept comment "DHCPv4 client"
		udp dport 546 accept comment "DHCPv6 client"
		tcp dport { $ports } accept comment "SSH"
	}
}
EOF
}

# render_env EXISTING TEMPLATE BUDGET IMAGE IMAGE_SET STORAGE ZFS_ROOT
# HOST_FIREWALL IPV6 SUBNET6 [KSM]: imp-host.env with bootstrap's keys set. EXISTING (empty when there is no
# file) wins over TEMPLATE; the operator's other lines stay. IMP_HOST_IMAGE
# is set when IMAGE_SET is non-empty, and a LEGACY_IMAGE_LINE becomes the
# commented pin of IMAGE otherwise (the units run their release's image).
# IMP_RAM_BUDGET_MIB is set when it is empty or still the template's,
# IMP_STORAGE_BACKEND,
# IMP_HOST_FIREWALL, IMP_HOST_IPV6 and IMP_HOST_NETWORK (from IPV6) always,
# IMP_ZFS_ROOT and IMP_HOST_SUBNET6 when theirs is non-empty, and IMP_KSM=1
# or 0 when KSM is on or off (an existing IMP_KSM stays when it is empty).
# TAILSCALE_AUTHKEY comes from the
# environment variable BOOTSTRAP_AUTHKEY, never from argv, and is set when
# non-empty.
render_env() {
  local base=$1 template=$2 budget=$3 img=$4 img_set=$5
  [ -z "$base" ] && base=$template
  BUDGET=$budget IMG=$img IMG_SET=$img_set TEMPLATE_BUDGET=$TEMPLATE_BUDGET_MIB \
    LEGACY_IMAGE=$LEGACY_IMAGE_LINE \
    STORAGE=$6 ZFS_ROOT=$7 HOST_FIREWALL=$8 IPV6=$9 SUBNET6=${10} KSM=${11:-} \
    NETWORK=$([ "$9" != on ] || echo "--network $HOST_NETWORK") \
    awk '
      function set(key, value) { print key "=" value; done[key] = 1 }
      function trim(s) { sub(/\r$/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
      /^IMP_HOST_IMAGE=/ && ENVIRON["IMG_SET"] != "" { set("IMP_HOST_IMAGE", ENVIRON["IMG"]); next }
      trim($0) == ENVIRON["LEGACY_IMAGE"] { print "# IMP_HOST_IMAGE=" ENVIRON["IMG"]; next }
      /^IMP_STORAGE_BACKEND=/ { set("IMP_STORAGE_BACKEND", ENVIRON["STORAGE"]); next }
      /^IMP_ZFS_ROOT=/ && ENVIRON["ZFS_ROOT"] != "" { set("IMP_ZFS_ROOT", ENVIRON["ZFS_ROOT"]); next }
      /^IMP_HOST_FIREWALL=/ { set("IMP_HOST_FIREWALL", ENVIRON["HOST_FIREWALL"]); next }
      /^IMP_HOST_IPV6=/ { set("IMP_HOST_IPV6", ENVIRON["IPV6"]); next }
      /^IMP_HOST_NETWORK=/ { set("IMP_HOST_NETWORK", ENVIRON["NETWORK"]); next }
      /^IMP_HOST_SUBNET6=/ && ENVIRON["SUBNET6"] != "" { set("IMP_HOST_SUBNET6", ENVIRON["SUBNET6"]); next }
      /^IMP_KSM=/ && ENVIRON["KSM"] != "" { set("IMP_KSM", ENVIRON["KSM"] == "on" ? "1" : "0"); next }
      /^TAILSCALE_AUTHKEY=/ && ENVIRON["BOOTSTRAP_AUTHKEY"] != "" {
        set("TAILSCALE_AUTHKEY", ENVIRON["BOOTSTRAP_AUTHKEY"]); next
      }
      /^IMP_RAM_BUDGET_MIB=/ {
        value = substr($0, length("IMP_RAM_BUDGET_MIB=") + 1)
        if (value == "" || value == ENVIRON["TEMPLATE_BUDGET"]) { set("IMP_RAM_BUDGET_MIB", ENVIRON["BUDGET"]); next }
        done["IMP_RAM_BUDGET_MIB"] = 1
      }
      { print }
      END {
        if (!done["IMP_HOST_IMAGE"] && ENVIRON["IMG_SET"] != "") set("IMP_HOST_IMAGE", ENVIRON["IMG"])
        if (!done["TAILSCALE_AUTHKEY"] && ENVIRON["BOOTSTRAP_AUTHKEY"] != "") set("TAILSCALE_AUTHKEY", ENVIRON["BOOTSTRAP_AUTHKEY"])
        if (!done["IMP_RAM_BUDGET_MIB"]) set("IMP_RAM_BUDGET_MIB", ENVIRON["BUDGET"])
        if (!done["IMP_STORAGE_BACKEND"]) set("IMP_STORAGE_BACKEND", ENVIRON["STORAGE"])
        if (!done["IMP_ZFS_ROOT"] && ENVIRON["ZFS_ROOT"] != "") set("IMP_ZFS_ROOT", ENVIRON["ZFS_ROOT"])
        if (!done["IMP_HOST_FIREWALL"]) set("IMP_HOST_FIREWALL", ENVIRON["HOST_FIREWALL"])
        if (!done["IMP_HOST_IPV6"]) set("IMP_HOST_IPV6", ENVIRON["IPV6"])
        if (!done["IMP_HOST_NETWORK"]) set("IMP_HOST_NETWORK", ENVIRON["NETWORK"])
        if (!done["IMP_HOST_SUBNET6"] && ENVIRON["SUBNET6"] != "") set("IMP_HOST_SUBNET6", ENVIRON["SUBNET6"])
        if (!done["IMP_KSM"] && ENVIRON["KSM"] != "") set("IMP_KSM", ENVIRON["KSM"] == "on" ? "1" : "0")
      }
    ' <<<"$base"
}

# --- embedded deploy files: keep equal to deploy/ (the test checks) ---

unit_imp_host() {
  cat <<'EOF'
# imp host as a systemd service. One of the two supported ways to run the
# release image; deploy/compose.yaml is the other. Run one, not both.
#
#   install -m 0644 deploy/imp-host.service deploy/imp-docker-proxy.service /etc/systemd/system/
#   install -D -m 0600 deploy/imp-host.env.example /etc/imp/imp-host.env  # then edit
#   systemctl daemon-reload && systemctl enable --now imp-docker-proxy imp-host
#   deploy/upgrade.sh   to a new image
#
# /var/lib/imp must be XFS with reflink (docs/guides/install.md).
[Unit]
Description=imp host (impd, Firecracker, tailscaled)
Documentation=https://github.com/zgeoff/imp/blob/main/docs/guides/install.md
Requires=docker.service
After=docker.service network-online.target imp-docker-proxy.service
# impd reaches Docker through the proxy's socket. Wants, not BindsTo: a
# proxy that stops fails image work only, and the imps keep running.
Wants=network-online.target imp-docker-proxy.service
# With XFS, /var/lib/imp is a host mount; never start before it is there.
RequiresMountsFor=/var/lib/imp

[Service]
Type=exec
# The image of this unit's own release; an IMP_HOST_IMAGE in the env file,
# read after it, pins another. release-please bumps the version.
# x-release-please-start-version
Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:0.40.4
# x-release-please-end
EnvironmentFile=/etc/imp/imp-host.env
# A container left over from a crash would hold the name.
ExecStartPre=-/usr/bin/docker rm -f imp-host
# With IPv6 (IMP_HOST_NETWORK names it), the network imp-host on its /64,
# created when it is missing; bootstrap.sh --check reports one that differs.
# Keep it equal to create_host_network in deploy/bootstrap.sh and the
# networks block of deploy/compose.yaml.
ExecStartPre=/bin/sh -c 'case "$$IMP_HOST_NETWORK" in *imp-host*) /usr/bin/docker network inspect imp-host >/dev/null 2>&1 || /usr/bin/docker network create --ipv6 --subnet "$$IMP_HOST_SUBNET6" -o com.docker.network.bridge.name=br-imphost imp-host ;; esac'
# The probed args (such as --device /dev/zfs) whose path this host has, into
# IMP_HOST_PROBED; systemd reads the file again for ExecStart.
RuntimeDirectory=imp-host
EnvironmentFile=-/run/imp-host/probed.env
ExecStartPre=/bin/sh -c 'a=; [ -e /dev/zfs ] && a="$$a --device /dev/zfs"; [ -e /proc/sys/net/ipv6 ] && a="$$a --sysctl net.ipv6.conf.all.forwarding=1 --sysctl net.ipv6.conf.default.accept_ra=0 --sysctl net.ipv6.conf.default.accept_redirects=0 --sysctl net.ipv6.conf.default.disable_ipv6=0"; { echo "IMP_HOST_PROBED=$$a"; echo "IMP_HOST_ADDRESSES=$$(ip -o addr show scope global | tr -s " " | cut -d " " -f 4 | paste -sd ,)"; } >/run/imp-host/probed.env'
# In the foreground and without a docker restart policy: systemd supervises
# it and restarts it on failure.
# --hostname: restic's backup locks name the host (docs/architecture/backups.md)
# $IMP_PUBLIC_PORTS, unbraced, is zero or more words from the env file: for
# public imps, `-p 443:7443 -p 80:7480` (docs/guides/https.md#public-imps);
# $IMP_HOST_NETWORK too: with IPv6, `--network imp-host`
# The arguments come from deploy/imp-host.args.json: edit that, then run
# bun run render:deploy (the NixOS module reads the same file).
ExecStart=/usr/bin/docker run --rm --name imp-host --hostname imp-host \
  --init --cgroupns=private --cap-drop ALL \
  --cap-add SYS_ADMIN --cap-add NET_ADMIN --cap-add MKNOD \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --cap-add SYS_PTRACE --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add FSETID --cap-add SETFCAP \
  --security-opt apparmor=unconfined \
  --security-opt seccomp=/etc/imp/imp-host.seccomp.json \
  --device /dev/kvm --device /dev/net/tun \
  --sysctl net.ipv4.ip_forward=1 \
  --env-file /etc/imp/imp-host.env \
  $IMP_HOST_NETWORK \
  -v /var/lib/imp:/var/lib/imp \
  -v /run/imp-docker:/run/imp-docker:ro \
  -e DOCKER_HOST=unix:///run/imp-docker/docker.sock \
  -e IMP_HOST_ADDRESSES \
  -v /etc/imp:/etc/imp:ro \
  -p 127.0.0.1:7070:7070 -p 127.0.0.1:7080:7080 \
  $IMP_PUBLIC_PORTS \
  $IMP_HOST_PROBED \
  ${IMP_HOST_IMAGE}
# SIGTERM makes impd sleep every awake imp, so memory survives; it gets up
# to 120 s, and systemd waits a little longer before it kills anything.
ExecStop=/usr/bin/docker stop -t 120 imp-host
TimeoutStopSec=150
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

unit_imp_docker_proxy() {
  cat <<'EOF'
# imp-docker-proxy: the only Docker socket imp-host sees. It passes the
# calls impd makes (pull, build, create, export, rm) and refuses every other
# (docs/architecture/host-contract.md#the-docker-socket). It closes the
# Docker socket path only: imp-host keeps SYS_ADMIN, which still lets root
# out of the container.
#
#   install -m 0644 deploy/imp-docker-proxy.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now imp-docker-proxy
#
# imp-host.service wants this unit and starts after it; deploy/bootstrap.sh
# and deploy/upgrade.sh install both.
[Unit]
Description=imp Docker socket proxy (the Docker API calls impd makes)
Documentation=https://github.com/zgeoff/imp/blob/main/docs/architecture/host-contract.md
Requires=docker.service
After=docker.service

[Service]
Type=exec
# The image of this unit's own release; an IMP_HOST_IMAGE in the env file,
# read after it, pins another. release-please bumps the version.
# x-release-please-start-version
Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:0.40.4
# x-release-please-end
# IMP_HOST_IMAGE, whose repository a pull may not move,
# IMP_BUILD_CONTEXT_MAX_MIB, and IMP_BUILD_ISOLATION and IMP_BUILD_IMAGE, the
# one image a pull may fetch under imp isolation. Only those four reach the
# container (-e NAME); it never sees the rest of the file, such as
# TAILSCALE_AUTHKEY.
EnvironmentFile=/etc/imp/imp-host.env
ExecStartPre=-/usr/bin/docker rm -f imp-docker-proxy
# The socket's directory and the proxy's token, owned by the proxy's user.
# Not RuntimeDirectory=: a stop would remove the directory under imp-host's
# bind mount.
ExecStartPre=/usr/bin/install -d -m 0700 -o 65534 -g 65534 /run/imp-docker /var/lib/imp-docker-proxy
# a socket left by a crash would pass the wait below before the proxy binds
ExecStartPre=/bin/rm -f /run/imp-docker/docker.sock
# The proxy runs as 65534 and joins the group of the host's socket, read
# here as IMP_DOCKER_GID; systemd reads the file again for ExecStart.
RuntimeDirectory=imp-docker-proxy
EnvironmentFile=-/run/imp-docker-proxy/gid.env
ExecStartPre=/bin/sh -c 'echo "IMP_DOCKER_GID=$$(stat -c %%g /var/run/docker.sock)" >/run/imp-docker-proxy/gid.env'
# The arguments come from the proxy section of deploy/imp-host.args.json:
# edit that, then run bun run render:deploy (the NixOS module reads the same
# file).
ExecStart=/usr/bin/docker run --rm --name imp-docker-proxy \
  --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp \
  --network none \
  --user 65534:65534 \
  --group-add $IMP_DOCKER_GID \
  -e IMP_HOST_IMAGE -e IMP_BUILD_CONTEXT_MAX_MIB \
  -e IMP_BUILD_ISOLATION -e IMP_BUILD_IMAGE \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /run/imp-docker:/run/imp-docker \
  -v /var/lib/imp-docker-proxy:/var/lib/imp-docker-proxy \
  ${IMP_HOST_IMAGE} /usr/local/bin/imp-docker-proxy
# Up once the socket is there, so impd's first docker call finds it.
ExecStartPost=/bin/sh -c 'for i in $$(seq 300); do [ -S /run/imp-docker/docker.sock ] && exit 0; sleep 0.1; done; echo "imp-docker-proxy: no socket after 30 s" >&2; exit 1'
ExecStop=/usr/bin/docker stop -t 10 imp-docker-proxy
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
}

env_template() {
  cat <<'EOF'
# imp host settings. Copy to /etc/imp/imp-host.env (mode 0600: it holds the
# Tailscale key and the DNS token). Both deploy/imp-host.service and deploy/compose.yaml pass
# it to the container. docs/guides/configuration.md lists every variable.
#
# docker --env-file format: KEY=value, one per line, no quotes, no
# expansion. An empty value counts as unset.

# The image to run. Unset, the systemd units run the image of their own
# release, and deploy/upgrade.sh moves them to its own. Set it to pin
# another; to follow latest, leave the tag off: ghcr.io/zgeoff/imp-host.
# Compose reads it from the shell or a .env next to compose.yaml instead.
# x-release-please-start-version
# IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:0.40.4
# x-release-please-end

# A tagged, non-ephemeral auth key (docs/guides/tailscale.md). Without one
# the host is local-only: the API listens on 127.0.0.1:7070 and no imp is
# reachable from elsewhere.
TAILSCALE_AUTHKEY=
IMP_TAILSCALE_HOSTNAME=imp

# HTTPS on your own domain (docs/guides/https.md): every imp at
# https://<name>.<domain> on the tailnet. The token is a Cloudflare API token
# with Zone:Read and DNS:Edit on the zone. Set IMP_DNS_API_TOKEN, or put the
# token alone in a file (root, 0400) and name it in IMP_DNS_API_TOKEN_FILE
# instead, not both; impd reads the file at each use, so a new token needs
# no restart. The container sees /etc/imp read-only.
IMP_DOMAIN=
IMP_DNS_PROVIDER=cloudflare
IMP_DNS_API_TOKEN=
# IMP_DNS_API_TOKEN_FILE=/etc/imp/dns-api-token
IMP_ACME_EMAIL=

# Public imps (docs/guides/https.md#public-imps): `imp expose <name>` serves
# an imp to the internet. IMP_PUBLIC_IP is the host's public IPv4, which
# their records point at. With the systemd unit, IMP_PUBLIC_PORTS publishes
# the public listeners: -p 443:7443 -p 80:7480. With compose, uncomment the
# two ports in deploy/compose.yaml instead.
IMP_PUBLIC_IP=
IMP_PUBLIC_PORTS=

# The public egress policy (docs/architecture/networking.md#public): more
# addresses no public imp may reach, IPv4 and IPv6, comma-separated. The
# systemd unit writes this host's global addresses into IMP_HOST_ADDRESSES at
# each start; list what that misses. With deploy/compose.yaml, list every
# address this host owns: impd cannot see them from inside the container.
# IMP_PUBLIC_IP is always in it.
IMP_EGRESS_DENY=

# The RAM awake imps may use, in MiB. Leave room for the host itself.
IMP_RAM_BUDGET_MIB=16384
IMP_IDLE_TIMEOUT_S=60
IMP_DEFAULT_IMAGE=base
IMP_DEFAULT_VCPUS=2
IMP_DEFAULT_MEMORY_MIB=2048

# Where disks live: xfs (a reflink XFS mount at /var/lib/imp) or zfs. With
# zfs, IMP_ZFS_ROOT is a dataset with mountpoint=legacy that the container
# mounts itself (docs/architecture/storage.md#zfs). The host's zfs module must
# be OpenZFS 2.x; impd warns when its minor version differs from the image's.
IMP_STORAGE_BACKEND=xfs
IMP_ZFS_ROOT=

# Who owns the host's inbound firewall (docs/architecture/host-contract.md):
# own, deploy/bootstrap.sh loads an nft table that admits SSH only; none, the
# platform does (NixOS networking.firewall), and imp adds no host rules.
# impd needs no inbound host port either way.
IMP_HOST_FIREWALL=own

# Imps' IPv6 (docs/guides/install.md#ipv6). on: imp-host runs on the Docker
# network imp-host, with the /64 IMP_HOST_SUBNET6 and the bridge br-imphost,
# behind Docker's NAT66; IMP_HOST_NETWORK is the docker run words for it.
# off: Docker's default bridge, IPv4 only. deploy/bootstrap.sh writes all
# three (--ipv6); empty IMP_HOST_IPV6 means it decides at its first run.
IMP_HOST_IPV6=
IMP_HOST_SUBNET6=
IMP_HOST_NETWORK=

# KSM merges identical guest pages
# (docs/architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages).
# Off by default: merged pages let guests time each other. bootstrap.sh --ksm
# sets IMP_KSM=1 on a host with Linux 6.10 or later, not in a container. The governor
# keeps this share of KSM's saving free, for pages that writes split again.
IMP_KSM=
IMP_KSM_HEADROOM_PERCENT=100

# Off-host backups with restic (docs/architecture/backups.md): unset
# IMP_BACKUP_REPOSITORY means none. The container sees /etc/imp read-only;
# keep the password there, mode 0600, and a copy off the host.
IMP_BACKUP_REPOSITORY=
IMP_BACKUP_PASSWORD_FILE=/etc/imp/restic-password
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Set when the uplink MTU is below 1500, so guest TCP is clamped to match.
IMP_UPLINK_MTU=
EOF
}

# The pool imports at boot (zfs-import-cache.service); the container needs
# it and /dev/zfs before it starts.
unit_imp_host_zfs() {
  cat <<'EOF'
# Written by deploy/bootstrap.sh: import the ZFS pool before imp starts.
[Unit]
Wants=zfs.target
After=zfs.target
EOF
}

unit_imp_firewall() {
  cat <<EOF
# Written by deploy/bootstrap.sh. Loads $FIREWALL_FILE before the network
# comes up, as Debian's nftables.service does.
[Unit]
Description=imp host firewall (inbound SSH only)
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $FIREWALL_FILE
ExecReload=/usr/sbin/nft -f $FIREWALL_FILE
ExecStop=/usr/sbin/nft delete table inet imp_host

[Install]
WantedBy=sysinit.target
EOF
}

# --- phases ---

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --yes | --dry-run | --check)
        [ -n "$mode" ] && die "give one of --yes, --dry-run and --check"
        mode=${1#--}
        ;;
      --storage) storage=${2:?--storage needs xfs or zfs} && shift ;;
      --zfs-pool) zfs_pool=${2:?--zfs-pool needs a name} && shift ;;
      --data-device) data_device=${2:?--data-device needs a device} && shift ;;
      --loop-file) loop_file=${2:?--loop-file needs a path} && shift ;;
      --loop-size) loop_size_gib=${2:?--loop-size needs GiB} && shift ;;
      --image) image=${2:?--image needs a reference} image_set=1 && shift ;;
      --image-archive) image_archive=${2:?--image-archive needs a file} && shift ;;
      --tailscale-authkey-file)
        [ -r "${2:-}" ] || die "--tailscale-authkey-file: cannot read ${2:-}"
        authkey=$(tr -d '[:space:]' <"$2")
        authkey_file=$2
        shift
        ;;
      --ssh-port) extra_ssh_ports+=("${2:?--ssh-port needs a port}") && shift ;;
      --host-firewall) host_firewall=${2:?--host-firewall needs own or none} host_firewall_set=1 && shift ;;
      --ipv6) ipv6=${2:?--ipv6 needs auto, on or off} ipv6_set=1 && shift ;;
      --ra-handled) ra_handled=1 ;;
      --skip-health) skip_health=1 ;;
      --ksm) ksm=on ;;
      --no-ksm) ksm=off ;;
      -h | --help) usage && exit 0 ;;
      *) usage >&2 && die "unknown argument: $1" ;;
    esac
    shift
  done
  [ -n "$mode" ] || { usage >&2 && die "give one of --yes, --dry-run and --check"; }
  if [ -n "$data_device" ] && [ -n "$loop_file" ]; then
    die "give --data-device or --loop-file, not both"
  fi
  [[ $loop_size_gib =~ ^([1-9][0-9]*|auto)$ ]] || die "--loop-size must be a whole number of GiB, or auto"
  case ${storage:-xfs} in xfs | zfs) ;; *) die "--storage must be xfs or zfs" ;; esac
  case ${host_firewall:-own} in own | none) ;; *) die "--host-firewall must be own or none" ;; esac
  case ${ipv6:-auto} in auto | on | off) ;; *) die "--ipv6 must be auto, on or off" ;; esac
  if [ -n "$zfs_pool" ] && ! [[ $zfs_pool =~ ^[A-Za-z][A-Za-z0-9_.:-]*$ ]]; then
    die "--zfs-pool must be a pool name: $zfs_pool"
  fi
  local port
  for port in "${extra_ssh_ports[@]}"; do
    [[ $port =~ ^[1-9][0-9]*$ ]] || die "--ssh-port must be a port number: $port"
  done
}

preflight() {
  phase preflight
  [ "$(id -u)" = 0 ] || die "run as root"
  if systemd-detect-virt -q --container 2>/dev/null; then
    in_container=1
    warn "running in a container: kernel settings are written, not applied"
  fi
  # The dev box is WSL2 Ubuntu; a stray run there must not touch it. A test
  # container on that box shares its kernel but is allowed (see above).
  if grep -qi microsoft /proc/sys/kernel/osrelease && [ -z "$in_container" ]; then
    die "refusing to run on WSL; this script is for a bare-metal server"
  fi

  # shellcheck source=/dev/null
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:24.04 | ubuntu:26.04 | debian:13) log "OS: $PRETTY_NAME" ;;
    *) die "unsupported OS ${PRETTY_NAME:-unknown}; use Ubuntu 24.04 or 26.04, or Debian 13" ;;
  esac
  [ "$(uname -m)" = x86_64 ] || die "the host image is x86_64 only"

  [ -c /dev/kvm ] || die "/dev/kvm is missing; enable VT-x/AMD-V in the firmware"
  grep -qwE 'vmx|svm' /proc/cpuinfo || die "the CPU reports neither vmx nor svm"

  resolve_storage
  resolve_host_firewall
  resolve_ipv6
  # --image writes the line again; without it the units would run no image
  if [ -z "$image_set" ]; then
    local refusal
    refusal=$(check_env_image "$ENV_FILE" 2>&1) || die "$refusal; or pass --image"
  fi
  if [ "$storage" = xfs ] && [ -z "$data_device" ] && [ -z "$loop_file" ] && ! mountpoint -q "$DATA_DIR"; then
    die "$DATA_DIR is not mounted; give --data-device DEV or --loop-file PATH"
  fi
  if [ -z "$authkey" ] && ! tailnet_joined; then
    warn "no Tailscale key: the host stays local-only (docs/guides/tailscale.md)"
  fi
}

# resolve_storage [ENV_FILE]: the backend and the ZFS dataset, from the
# flags, else the env file (default $ENV_FILE), so a later run without
# --storage keeps what the first chose.
resolve_storage() {
  local env_file=${1:-$ENV_FILE} env_storage="" env_root=""
  if [ -f "$env_file" ]; then
    env_storage=$(sed -n 's/^IMP_STORAGE_BACKEND=//p' "$env_file" | tail -n 1)
    env_root=$(sed -n 's/^IMP_ZFS_ROOT=//p' "$env_file" | tail -n 1)
  fi
  storage=${storage:-${env_storage:-xfs}}
  # The template says xfs, so an env file copied from it says nothing about
  # where imps live. XFS imps live on the /var/lib/imp mount, which ZFS
  # refuses below; ZFS imps live in IMP_ZFS_ROOT.
  if [ "$env_storage" = zfs ] && [ -n "$env_root" ] && [ "$storage" = xfs ]; then
    die "$env_file says IMP_STORAGE_BACKEND=zfs on $env_root; switching backends would leave every imp behind"
  fi
  log "storage: $storage"
  [ "$storage" = zfs ] || return 0
  [ -z "$loop_file" ] || die "--loop-file is XFS only; ZFS needs --data-device or an existing pool"
  if [ -n "$zfs_pool" ]; then
    zfs_root=$zfs_pool/imp
  else
    zfs_root=${env_root:-tank/imp}
    zfs_pool=${zfs_root%%/*}
  fi
  if [ -n "$env_root" ] && [ "$zfs_root" != "$env_root" ]; then
    die "$env_file says IMP_ZFS_ROOT=$env_root, not $zfs_root"
  fi
  if mountpoint -q "$DATA_DIR"; then
    die "$DATA_DIR is a mount on the host; with ZFS the container mounts $zfs_root there itself"
  fi
  # An XFS host whose nofail mount is down still has its imps on that disk.
  if grep -qE "^[^#]*[[:space:]]${DATA_DIR}[[:space:]]" /etc/fstab; then
    die "/etc/fstab has an entry for $DATA_DIR (XFS imps); ZFS would leave them behind"
  fi
}

# trim_lines: stdin without a trailing \r or the blanks around each line, as
# an env file edited on another system may have them
trim_lines() { awk '{ sub(/\r$/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print }'; }

# strip_markers: stdin without the release-please marker lines, which only
# the repo's copies need
strip_markers() { grep -vE '^# x-release-please-(start-[a-z]+|end)$' || true; }

# check_env_image FILE: fails, and says why, when FILE's last IMP_HOST_IMAGE
# is empty: systemd passes it over the units' own image, and docker run gets
# none. Keep it equal to check_env_image in deploy/upgrade.sh.
check_env_image() {
  [ -f "$1" ] || return 0
  [ "$(trim_lines <"$1" | grep '^IMP_HOST_IMAGE=' | tail -n 1)" = IMP_HOST_IMAGE= ] || return 0
  echo "$1 sets IMP_HOST_IMAGE= empty, which systemd passes over the units' own image: delete the line, or set an image" >&2
  return 1
}

# resolve_host_firewall: the flag, else the env file, else own.
resolve_host_firewall() {
  local env_value=""
  [ -f "$ENV_FILE" ] && env_value=$(sed -n 's/^IMP_HOST_FIREWALL=//p' "$ENV_FILE" | tail -n 1)
  host_firewall=${host_firewall:-${env_value:-own}}
  case $host_firewall in own | none) ;; *) die "$ENV_FILE says IMP_HOST_FIREWALL=$host_firewall; want own or none" ;; esac
  log "host firewall: $host_firewall"
}

# resolve_ipv6: the flag, else the env file's choice, else auto. The env
# file keeps on or off, never auto, so a later run on a host whose IPv6
# route is down for a moment does not take imps' IPv6 away.
resolve_ipv6() {
  local env_value="" uplink
  [ -f "$ENV_FILE" ] && env_value=$(sed -n 's/^IMP_HOST_IPV6=//p' "$ENV_FILE" | tail -n 1)
  ipv6=${ipv6:-${env_value:-auto}}
  case $ipv6 in
    on | off) log "ipv6: $ipv6" ;;
    auto)
      ipv6_auto=1
      if uplink=$(global_ipv6_uplink); then
        ipv6=on
        log "ipv6: on (auto: $uplink has a global IPv6 default route)"
      else
        ipv6=off
        log "ipv6: off (auto: the host has no global IPv6 default route)"
      fi
      ;;
    *) die "$ENV_FILE says IMP_HOST_IPV6=$ipv6; want on or off" ;;
  esac
}

# global_ipv6_uplink: the uplink of the host's IPv6 default route, when it
# has a global address (not fc00::/7, not link-local).
global_ipv6_uplink() {
  local uplink
  uplink=$(route_uplink "$(ip -6 route show default 2>/dev/null | head -n 1)")
  [ -n "$uplink" ] || return 1
  ip -6 -o addr show dev "$uplink" scope global 2>/dev/null | awk '{ print $4 }' | grep -qvE '^f[cd]' || return 1
  echo "$uplink"
}

ensure_packages() {
  phase packages
  local wanted=(ca-certificates curl gnupg xfsprogs nftables jq iproute2 util-linux)
  local pkg missing=()
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}" apt_install "${missing[@]}"
  fi
  [ "$storage" != zfs ] || ensure_zfs_packages
  ensure_docker
}

# Ubuntu ships the zfs module with its kernel; Debian builds it with DKMS,
# from contrib.
ensure_zfs_packages() {
  # shellcheck source=/dev/null
  . /etc/os-release
  local wanted=(zfsutils-linux) pkg missing=()
  if [ "$ID" = debian ]; then
    put_file /etc/apt/sources.list.d/imp-contrib.sources 644 "$(debian_contrib_sources)" || true
    wanted=("linux-headers-$(uname -r)" zfs-dkms zfsutils-linux)
  fi
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}" apt_install "${missing[@]}"
  fi
}

debian_contrib_sources() {
  cat <<'EOF'
# Written by deploy/bootstrap.sh: contrib, for zfs-dkms and zfsutils-linux.
Types: deb
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: contrib
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
}

# apt_install PKG...: apt's output goes to a log, shown only on failure.
apt_install() {
  local apt_log=/var/log/imp-bootstrap-apt.log
  if ! {
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"
  } >"$apt_log" 2>&1; then
    tail -n 20 "$apt_log" >&2
    die "apt-get install $* failed; the whole log is in $apt_log"
  fi
}

# Docker CE from Docker's apt repo, as host/Dockerfile uses. A Docker that is
# already installed (docker-ce or the distro's docker.io) is kept.
ensure_docker() {
  local pkg
  for pkg in docker-ce docker.io; do
    if dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
      log "docker: $pkg is installed"
      ensure_service docker
      return
    fi
  done
  # shellcheck source=/dev/null
  . /etc/os-release
  local key=/etc/apt/keyrings/docker.asc
  if [ ! -s "$key" ]; then
    change "fetch Docker's apt key to $key" fetch_docker_key "$key" "$ID"
  fi
  # A dry run has not fetched it; an existing key is checked every run.
  [ ! -s "$key" ] || check_docker_key "$key"
  put_file /etc/apt/sources.list.d/docker.list 644 \
    "deb [arch=amd64 signed-by=$key] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" || true
  change "apt-get install docker-ce" apt_install docker-ce docker-ce-cli containerd.io
  ensure_service docker
}

fetch_docker_key() {
  install -m 0755 -d "$(dirname "$1")" || return 1
  curl -fsSL "https://download.docker.com/linux/$2/gpg" -o "$1.new" || return 1
  check_docker_key "$1.new" && chmod 0644 "$1.new" && mv "$1.new" "$1"
}

# check_docker_key FILE: the file holds Docker's key and only that key.
check_docker_key() {
  local fingerprints
  fingerprints=$(gpg --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "pub" { pub = 1 } $1 == "fpr" && pub { print $10; pub = 0 }')
  if [ "$fingerprints" != "$DOCKER_KEY_FINGERPRINT" ]; then
    rm -f "$1.new"
    die "$1 is not Docker's apt key (want $DOCKER_KEY_FINGERPRINT, got ${fingerprints:-none})"
  fi
}

# ensure_service UNIT: enabled and active.
ensure_service() {
  systemctl -q is-enabled "$1" 2>/dev/null || change "enable $1" systemctl enable -q "$1"
  systemctl -q is-active "$1" 2>/dev/null || change "start $1" systemctl start "$1"
}

# Storage backends: xfs now; ZFS (#11) adds storage_zfs and a flag.
ensure_storage() {
  phase storage
  case $storage in
    xfs) storage_xfs ;;
    zfs) storage_zfs ;;
  esac
}

storage_xfs() {
  if mountpoint -q "$DATA_DIR"; then
    check_xfs_reflink
    grep -qE "[[:space:]]${DATA_DIR}[[:space:]]" /etc/fstab \
      || warn "$DATA_DIR is mounted but not in /etc/fstab; it will not come back after a reboot"
    findmnt -n -o OPTIONS --mountpoint "$DATA_DIR" | tr ',' '\n' | grep -qx nosuid \
      || warn "$DATA_DIR is mounted without nosuid; add nosuid to its /etc/fstab entry and run: mount -o remount,nosuid $DATA_DIR"
  else
    local source
    if [ -n "$data_device" ]; then
      prepare_device "$data_device"
      source=$(device_source "$data_device")
      ensure_fstab "$(fstab_line "$source" device)"
    else
      prepare_loop_file
      ensure_fstab "$(fstab_line "$loop_file" loop)"
    fi
    change "mount $DATA_DIR" mount_data
    dry || check_xfs_reflink
  fi
  local dir
  for dir in db system images imps; do
    [ -d "$DATA_DIR/$dir" ] || change "mkdir $DATA_DIR/$dir" mkdir -p "$DATA_DIR/$dir"
  done
}

mount_data() {
  mkdir -p "$DATA_DIR"
  systemctl daemon-reload
  mount "$DATA_DIR"
}

check_xfs_reflink() {
  [ "$(findmnt -n -o FSTYPE --mountpoint "$DATA_DIR")" = xfs ] \
    || die "$DATA_DIR is mounted but not XFS; imp needs XFS with reflink"
  [[ $(xfs_info "$DATA_DIR") == *reflink=1* ]] \
    || die "$DATA_DIR is XFS without reflink; recreate it with mkfs.xfs -m reflink=1"
  log "$DATA_DIR is XFS with reflink"
}

# device_source DEV: UUID=… once DEV has a filesystem; the device path in a
# dry run, before mkfs.
device_source() {
  local uuid
  uuid=$(blkid -s UUID -o value "$1" 2>/dev/null || true)
  if [ -n "$uuid" ]; then echo "UUID=$uuid"; else echo "$1"; fi
}

# check_device_free DEV: refuse a device that may hold data in use.
check_device_free() {
  local dev=$1
  [ -b "$dev" ] || die "$dev is not a block device"
  dev=$(readlink -f "$dev")
  local root_disk
  root_disk=$(findmnt -n -o SOURCE / | sed 's/\[.*//')
  if lsblk -n -s -o PATH "$root_disk" 2>/dev/null | grep -qx "$dev"; then
    die "$dev holds the root filesystem"
  fi
  if [ -n "$(lsblk -n -o MOUNTPOINTS "$dev" | tr -d '[:space:]')" ]; then
    die "$dev or a partition on it is mounted"
  fi
  if [ "$(lsblk -n -o PATH "$dev" | wc -l)" -gt 1 ]; then
    die "$dev has partitions or holders (RAID, LVM); give an empty disk or partition"
  fi
}

# prepare_device DEV: refuse anything that may hold data, then mkfs it. A
# device that already holds an XFS with reflink is reused (a second run).
prepare_device() {
  local dev=$1
  check_device_free "$dev"
  local fstype
  fstype=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
  case $fstype in
    xfs) log "$dev already holds XFS; reusing it" ;;
    "")
      if blkid -p "$dev" >/dev/null 2>&1; then
        die "$dev carries a signature (a partition table?); wipe it by hand if it is free"
      fi
      # shellcheck disable=SC2046 # the options are words
      change "mkfs.xfs $dev" mkfs.xfs -q $(mkfs_xfs_opts "$(uname -r)" "$(xfsprogs_version)") "$dev"
      ;;
    *) die "$dev holds $fstype; give an empty disk or partition" ;;
  esac
}

# storage_zfs: the pool (created on --data-device, imported, or already
# there) and the dataset imp mounts, with mountpoint=legacy. The host never
# mounts it: the container mounts it on /var/lib/imp, and impd creates the
# children (docs/architecture/storage.md#zfs).
storage_zfs() {
  if command -v zpool >/dev/null && zpool list -H -o name "$zfs_pool" >/dev/null 2>&1; then
    log "pool $zfs_pool is imported"
  elif [ -n "$data_device" ]; then
    check_device_free "$data_device"
    local fstype
    fstype=$(blkid -p -s TYPE -o value "$data_device" 2>/dev/null || true)
    case $fstype in
      zfs_member)
        [ "$(blkid -p -s LABEL -o value "$data_device")" = "$zfs_pool" ] \
          || die "$data_device belongs to another ZFS pool"
        change "zpool import $zfs_pool" zpool import "$zfs_pool"
        ;;
      "")
        if blkid -p "$data_device" >/dev/null 2>&1; then
          die "$data_device carries a signature (a partition table?); wipe it by hand if it is free"
        fi
        change "zpool create $zfs_pool on $data_device" zpool create -o ashift=12 \
          -O compression=lz4 -O atime=off -O xattr=sa -O mountpoint=none "$zfs_pool" "$data_device"
        ;;
      *) die "$data_device holds $fstype; give an empty disk or partition" ;;
    esac
  else
    die "no pool $zfs_pool; give --data-device DEV to create it"
  fi

  if ! command -v zfs >/dev/null || ! zfs list -H -o name "$zfs_root" >/dev/null 2>&1; then
    change "zfs create $zfs_root (mountpoint=legacy)" zfs create -o mountpoint=legacy "$zfs_root"
  elif [ "$(zfs get -H -o value mountpoint "$zfs_root")" != legacy ]; then
    change "zfs set mountpoint=legacy $zfs_root" zfs set mountpoint=legacy "$zfs_root"
  else
    log "dataset $zfs_root is there, mountpoint=legacy"
  fi
  [ -d "$DATA_DIR" ] || change "mkdir $DATA_DIR" mkdir -p "$DATA_DIR"
}

prepare_loop_file() {
  local dir avail_gib
  dir=$(dirname "$loop_file")
  [ "$(findmnt -n -o TARGET --target "$dir")" = / ] \
    || die "--loop-file must be on the root filesystem, which mounts before $DATA_DIR"
  if [ -e "$loop_file" ]; then
    [ "$(blkid -p -s TYPE -o value "$loop_file" 2>/dev/null || true)" = xfs ] \
      || die "$loop_file exists and is not XFS"
    log "$loop_file already holds XFS; reusing it"
    return
  fi
  avail_gib=$(($(df --output=avail -k / | tail -n 1) / 1024 / 1024))
  if [ "$loop_size_gib" = auto ]; then
    loop_size_gib=$(loop_size_auto_gib "$avail_gib")
    log "${avail_gib} GiB free on /; the loop file gets ${loop_size_gib} GiB"
  elif [ $((avail_gib - loop_size_gib)) -lt "$(loop_reserve_gib "$avail_gib")" ]; then
    warn "$loop_file is sparse: once full, ${loop_size_gib} GiB leaves under $(loop_reserve_gib "$avail_gib") GiB of the ${avail_gib} GiB free on / for the OS"
  fi
  [ "$loop_size_gib" -ge "$LOOP_MIN_GIB" ] \
    || die "a ${loop_size_gib} GiB loop file is too small (${avail_gib} GiB free on /); imp needs ${LOOP_MIN_GIB}"
  change "create a ${loop_size_gib} GiB sparse XFS file $loop_file" make_loop_file
}

make_loop_file() {
  mkdir -p "$(dirname "$loop_file")"
  truncate -s "${loop_size_gib}G" "$loop_file"
  # shellcheck disable=SC2046 # the options are words
  mkfs.xfs -q $(mkfs_xfs_opts "$(uname -r)" "$(xfsprogs_version)") "$loop_file"
}

xfsprogs_version() {
  if command -v mkfs.xfs >/dev/null; then
    mkfs.xfs -V | grep -oE '[0-9]+(\.[0-9]+)+'
  else
    echo 0 # a dry run before the package is installed
  fi
}

ensure_fstab() {
  local line=$1
  case $(fstab_entry_state /etc/fstab "$line") in
    none) change "add $DATA_DIR to /etc/fstab" append_line /etc/fstab "$line" ;;
    same) ;;
    old) warn "$DATA_DIR in /etc/fstab lacks nosuid; add it to the entry, then run: mount -o remount,nosuid $DATA_DIR" ;;
    other) die "/etc/fstab has another entry for $DATA_DIR; fix or remove it first" ;;
  esac
}

append_line() { printf '%s\n' "$2" >>"$1"; }

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

# ksm_merges: ksmd runs, or pages it merged are still shared
ksm_merges() {
  local dir=${KSM_DIR:-/sys/kernel/mm/ksm}
  [ "$(cat "$dir/run" 2>/dev/null || echo 0)" = 1 ] \
    || [ "$(cat "$dir/pages_shared" 2>/dev/null || echo 0)" -gt 0 ]
}

# ensure_ksm: with --ksm, ksmd runs now and at boot; with --no-ksm, its boot
# rule goes and run=2 stops ksmd and unmerges every merged page. A running imp
# keeps its merge flag until it restarts. KSM is global to the kernel, so a
# container refuses --ksm, and so does a kernel older than 6.10.
ensure_ksm() {
  [ -n "$ksm" ] || return 0
  phase ksm
  local rule=/etc/tmpfiles.d/imp-ksm.conf
  if [ "$ksm" = off ]; then
    [ ! -f "$rule" ] || change "remove $rule" rm -f "$rule"
    [ -n "$in_container" ] || ! ksm_merges \
      || change "stop ksmd and unmerge its pages" write_param /sys/kernel/mm/ksm/run 2
    return 0
  fi
  [ -z "$in_container" ] || die "--ksm cannot run in a container: KSM is global to the host's kernel"
  kernel_supports_ksm "$(uname -r)" || die "--ksm needs Linux 6.10 or later; this host runs $(uname -r)"
  [ -d /sys/kernel/mm/ksm ] || die "--ksm needs a kernel built with CONFIG_KSM"
  put_file "$rule" 644 "$(ksm_tmpfiles)" || true
  local key
  for key in use_zero_pages run; do
    [ "$(cat "/sys/kernel/mm/ksm/$key")" = 1 ] || change "set KSM $key=1" write_param "/sys/kernel/mm/ksm/$key" 1
  done
}

memtotal_kib() { awk '/^MemTotal:/ { print $2 }' /proc/meminfo; }

ensure_firewall() {
  phase firewall
  if [ "$host_firewall" = none ]; then
    if systemctl -q is-enabled nftables 2>/dev/null && grep -qE '^[[:space:]]*flush ruleset' /etc/nftables.conf 2>/dev/null; then
      warn "nftables.service is enabled and /etc/nftables.conf flushes every ruleset, Docker's too, at each reload"
    fi
    remove_firewall
    return
  fi
  if systemctl -q is-enabled nftables 2>/dev/null; then
    die "nftables.service is enabled; its /etc/nftables.conf flushes every ruleset (Docker's too). Disable it first"
  fi
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    change "disable ufw (imp-firewall.service replaces it)" disable_ufw
  fi
  if systemctl -q is-active firewalld 2>/dev/null; then
    change "stop and disable firewalld (imp-firewall.service replaces it)" systemctl disable -q --now firewalld
  fi

  local ports
  mapfile -t ports < <(ssh_ports)
  [ ${#ports[@]} -gt 0 ] || die "found no SSH port; give --ssh-port"
  # sudo drops SSH_CONNECTION by default, and without it the check below
  # cannot see the session's port. sudo-rs (Ubuntu 26.04) ignores -E, so
  # name the variable.
  if [ -z "${SSH_CONNECTION:-}" ] && [ -n "${SUDO_USER:-}" ]; then
    die "run as root, or with sudo --preserve-env=SSH_CONNECTION, so the firewall phase can check this SSH session's port"
  fi
  local session_port
  session_port=$(awk '{ print $4 }' <<<"${SSH_CONNECTION:-}")
  if [ -n "$session_port" ] && ! printf '%s\n' "${ports[@]}" | grep -qx "$session_port"; then
    die "this SSH session uses port $session_port, which sshd does not report; give --ssh-port $session_port"
  fi
  log "SSH ports kept open: ${ports[*]}"
  if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
    warn "sshd allows password logins; set PasswordAuthentication no"
  fi

  local ruleset changed=
  ruleset=$(render_firewall "${ports[@]}")
  check_ruleset "$ruleset"
  put_file "$FIREWALL_FILE" 644 "$ruleset" && changed=1
  put_file /etc/systemd/system/imp-firewall.service 644 "$(unit_imp_firewall)" && changed=1
  if [ -n "$changed" ]; then
    change "load the firewall" reload_unit imp-firewall
  else
    ensure_service imp-firewall
  fi
}

# remove_firewall: with none, take out what an earlier run with own put in,
# but only when --host-firewall none asks for it; an env file that says none
# beside a loaded table is drift for the operator to settle. Only our table
# goes; the platform's rules stay.
remove_firewall() {
  local loaded=""
  if [ -e /etc/systemd/system/imp-firewall.service ] || [ -e "$FIREWALL_FILE" ] \
    || { command -v nft >/dev/null && nft list table inet imp_host >/dev/null 2>&1; }; then
    loaded=1
  fi
  if [ -z "$loaded" ]; then
    log "host firewall: none; imp adds no host rules"
    return
  fi
  if [ -z "$host_firewall_set" ]; then
    local msg="IMP_HOST_FIREWALL=none, but imp-firewall is still installed; run with --host-firewall none to remove it"
    dry || die "$msg"
    warn "$msg"
    changes=$((changes + 1))
    return
  fi
  change "remove imp-firewall.service and the inet imp_host table" uninstall_firewall
}

uninstall_firewall() {
  systemctl disable -q --now imp-firewall 2>/dev/null || true
  if command -v nft >/dev/null && nft list table inet imp_host >/dev/null 2>&1; then
    nft delete table inet imp_host || return 1
  fi
  rm -f /etc/systemd/system/imp-firewall.service "$FIREWALL_FILE"
  systemctl daemon-reload
  # An earlier run with own disabled ufw and firewalld.
  # Read first: under pipefail, grep -q quitting early fails nft with SIGPIPE.
  local rules
  rules=$(nft list ruleset 2>/dev/null || true)
  if ! grep -q 'hook input' <<<"$rules" \
    && ! { command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; } \
    && ! systemctl -q is-active firewalld 2>/dev/null; then
    warn "the host now has no inbound firewall; the platform must give one (docs/architecture/host-contract.md#firewall)"
  fi
}

# check_ruleset RULESET: nft parses it against this kernel, so a bad ruleset
# never replaces a good one, or leaves the host with none. Skipped in a dry
# run before nftables is installed.
check_ruleset() {
  if ! command -v nft >/dev/null; then
    dry || die "nft is missing"
    return 0
  fi
  local file rc=0
  file=$(mktemp)
  printf '%s\n' "$1" >"$file"
  nft -c -f "$file" || rc=$?
  rm -f "$file"
  [ "$rc" = 0 ] || die "nft rejects the firewall ruleset; nothing was loaded"
}

disable_ufw() {
  ufw --force disable >/dev/null
  systemctl disable -q ufw
}

# ssh_ports: the union of the configured and the live SSH ports, plus
# --ssh-port. Ubuntu 24.04 starts sshd from ssh.socket, so sshd -T may not
# know the port the socket listens on.
ssh_ports() {
  {
    sshd -T 2>/dev/null | ssh_ports_from_sshd_t || true
    if systemctl -q is-active ssh.socket 2>/dev/null; then
      systemctl show -p Listen --value ssh.socket | ssh_ports_from_listen || true
    fi
    ss -Hltnp 2>/dev/null | awk '/"sshd/ { print $4 }' | ssh_ports_from_listen || true
    printf '%s\n' "${extra_ssh_ports[@]}"
  } | grep -E '^[0-9]+$' | sort -nu
}

# ensure_ipv6: with IPv6 on, imp-host's Docker network, and the host's
# router adverts kept once Docker turns on forwarding. Before the imp phase,
# so the unit's first start finds the network.
ensure_ipv6() {
  phase ipv6
  if [ "$ipv6" = off ]; then
    remove_ipv6
    return
  fi
  if ! check_docker_ipv6; then
    ipv6=off
    remove_ipv6
    return
  fi

  local inspect="" existing=""
  if command -v docker >/dev/null && inspect=$(docker network inspect -f "$NETWORK_FORMAT" "$HOST_NETWORK" 2>/dev/null); then
    existing=1
  fi
  resolve_subnet6 "$inspect"
  if ! ensure_router_adverts "$existing"; then
    ipv6=off
    remove_ipv6
    return
  fi

  if [ -z "$existing" ]; then
    change "create the $HOST_NETWORK network: $ipv6_subnet on the bridge $HOST_BRIDGE" create_host_network
    return
  fi
  local drift others
  drift=$(network_drift "$ipv6_subnet" "$inspect")
  if [ -z "$drift" ]; then
    log "network: $HOST_NETWORK, $ipv6_subnet on the bridge $HOST_BRIDGE"
    return
  fi
  others=$(network_others)
  [ -z "$others" ] || die "the $HOST_NETWORK network differs ($drift), and $others use it; move them off it, then run again"
  change "recreate the $HOST_NETWORK network ($drift): stop imp-host, then create it with $ipv6_subnet" recreate_host_network
}

# resolve_subnet6 INSPECT [ENV_FILE]: the env file's (default $ENV_FILE)
# IMP_HOST_SUBNET6, else the subnet of a network that is already right but
# for the env file, else a new random one.
resolve_subnet6() {
  local env_file=${2:-$ENV_FILE} env_value=""
  [ -f "$env_file" ] && env_value=$(sed -n 's/^IMP_HOST_SUBNET6=//p' "$env_file" | tail -n 1)
  if [ -n "$env_value" ]; then
    ipv6_subnet=$(subnet6 "$env_value") || die "$env_file says IMP_HOST_SUBNET6=$env_value; want an IPv6 /64"
    return
  fi
  ipv6_subnet=$(network_subnet6 "$1")
  [ -n "$ipv6_subnet" ] || ipv6_subnet=$(random_ula64)
}

# check_docker_ipv6: Docker writes the NAT66 and forward rules for an IPv6
# network itself from 27.0, where ip6tables became the default. A Docker
# without them refuses on, and turns auto off with a warning.
check_docker_ipv6() {
  # a dry run on a fresh host: the packages phase would install docker-ce
  command -v docker >/dev/null || return 0
  local version why=""
  version=$(docker version -f '{{.Server.Version}}' 2>/dev/null) || die "cannot read the Docker daemon's version"
  if ! version_ge "$version" 27.0; then
    why="Docker $version predates 27.0, which writes IPv6 NAT and forward rules by default"
  elif [ -f /etc/docker/daemon.json ] && [ "$(jq -r '.ip6tables' /etc/docker/daemon.json 2>/dev/null)" = false ]; then
    why="/etc/docker/daemon.json sets ip6tables to false, so imp-host's network would have no NAT66"
  fi
  [ -n "$why" ] || return 0
  [ -n "$ipv6_auto" ] || die "$why; fix that, or give --ipv6 off"
  warn "$why; ipv6: off"
  return 1
}

# ensure_router_adverts EXISTING: Docker sets net.ipv6.conf.all.forwarding=1
# for an IPv6 network, and with forwarding on the kernel ignores router
# adverts where accept_ra=1: a host whose IPv6 default route comes from them
# loses it when it expires. accept_ra is per network namespace, so this
# applies in a test container too. EXISTING: the network is there already.
ensure_router_adverts() {
  local route uplink live file_uplink=""
  route=$(ip -6 route show default 2>/dev/null | head -n 1)
  uplink=$(route_uplink "$route")
  if [ -z "$uplink" ]; then
    log "router adverts: the host has no IPv6 default route"
    return
  fi
  [ -f "$RA_FILE" ] && file_uplink=$(ra_file_uplink <"$RA_FILE")
  live=$(cat "/proc/sys/net/ipv6/conf/$uplink/accept_ra")
  # Ours already (a second run finds 2), or the kernel's to take.
  if [ "$file_uplink" = "$uplink" ] || { route_is_ra "$route" && [ "$live" = 1 ]; }; then
    put_file "$RA_FILE" 644 "$(render_ra_file "$uplink")" || true
    if [ "$live" != 2 ]; then
      change "sysctl net/ipv6/conf/$uplink/accept_ra=2, so the kernel takes router adverts with forwarding on" \
        sysctl -qw "net/ipv6/conf/$uplink/accept_ra=2"
    fi
    return
  fi
  if ! route_is_ra "$route"; then
    log "router adverts: the IPv6 default route on $uplink does not come from them"
    return
  fi
  if [ "$live" = 2 ]; then
    log "router adverts: the kernel takes them on $uplink, with accept_ra=2"
    return
  fi
  ra_userspace "$uplink" "$1"
}

# ra_userspace UPLINK EXISTING: accept_ra is 0, so a client takes the
# router adverts. Go on when its config keeps them with forwarding on, the
# operator says so (--ra-handled), or IPv6 was on already. Else auto turns
# IPv6 off with a warning (fails), and on stops.
ra_userspace() {
  local uplink=$1 owner network_file=""
  network_file=$(networkctl status "$uplink" 2>/dev/null | sed -n 's/^ *Network File: //p' || true)
  if [ -n "$network_file" ] && [ "$network_file" != n/a ]; then
    owner=systemd-networkd
    # networkd's IPv6AcceptRA defaults to off once forwarding is on; yes keeps it
    if cat "$network_file" "$network_file.d"/*.conf 2>/dev/null \
      | grep -qiE '^[[:space:]]*IPv6AcceptRA[[:space:]]*=[[:space:]]*(yes|true|on|1)[[:space:]]*$'; then
      log "router adverts: systemd-networkd takes them on $uplink, with IPv6AcceptRA=yes in $network_file"
      return
    fi
  elif nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -qx "$uplink:connected"; then
    owner=NetworkManager
  elif pgrep -x dhcpcd >/dev/null; then
    owner=dhcpcd
  else
    owner="a client other than the kernel"
  fi
  if [ -n "$ra_handled" ]; then
    log "router adverts: $owner takes them on $uplink; --ra-handled says it keeps them with forwarding on"
    return
  fi
  if [ -n "$2" ]; then
    log "router adverts: $owner takes them on $uplink; IPv6 was on already"
    return
  fi
  local why="the IPv6 default route on $uplink comes from router adverts that $owner takes. Docker turns on IPv6 forwarding for imp-host's network, and $owner may then drop them, and the route with them. Make it keep router adverts with forwarding on (systemd-networkd: IPv6AcceptRA=yes; netplan: accept-ra: true), then run again with --ipv6 on --ra-handled (docs/guides/install.md#ipv6)"
  [ -n "$ipv6_auto" ] || die "$why; or give --ipv6 off"
  warn "$why. ipv6: off"
  return 1
}

# network_others: the containers on the network other than imp-host.
network_others() {
  docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$HOST_NETWORK" 2>/dev/null \
    | tr ' ' '\n' | grep -vx -e imp-host -e '' | paste -sd ' ' - || true
}

# The network's three definitions agree: this one, the unit's ExecStartPre
# (deploy/imp-host.service) and the networks block of deploy/compose.yaml.
# deploy/bootstrap.test.ts checks the first two.
create_host_network() {
  docker network create --ipv6 --subnet "$ipv6_subnet" \
    -o "com.docker.network.bridge.name=$HOST_BRIDGE" "$HOST_NETWORK" >/dev/null
}

# stop_imp_host: stop the unit, so imp-host leaves the network.
stop_imp_host() {
  systemctl stop imp-host 2>/dev/null || true
  docker rm -f imp-host >/dev/null 2>&1 || true
}

recreate_host_network() {
  stop_imp_host
  docker network rm "$HOST_NETWORK" >/dev/null && create_host_network
}

# remove_ipv6: with off, take out what an earlier run with on put in, but
# only when --ipv6 off asks for it, as with the firewall: an env file that
# says off beside the network is drift for the operator to settle.
remove_ipv6() {
  local network="" file=""
  if command -v docker >/dev/null && docker network inspect "$HOST_NETWORK" >/dev/null 2>&1; then
    network=1
  fi
  [ ! -f "$RA_FILE" ] || file=1
  if [ -z "$network$file" ]; then
    log "ipv6: off; imp-host runs on Docker's default bridge"
    return
  fi
  if [ -z "$ipv6_set" ]; then
    local msg="IMP_HOST_IPV6=off, but the $HOST_NETWORK network or $RA_FILE is still there; run with --ipv6 off to remove them"
    dry || die "$msg"
    warn "$msg"
    changes=$((changes + 1))
    return
  fi
  if [ -n "$network" ]; then
    local others
    others=$(network_others)
    [ -z "$others" ] || die "$others use the $HOST_NETWORK network; move them off it, then run again"
    warn "turning IPv6 off cold-boots every imp that has an IPv6 prefix at its next start"
    change "stop imp-host and remove the $HOST_NETWORK network" remove_host_network
  fi
  # accept_ra stays 2 until a reboot, as forwarding stays on until then.
  [ -z "$file" ] || change "remove $RA_FILE (accept_ra keeps its value until a reboot)" rm -f "$RA_FILE"
}

remove_host_network() {
  stop_imp_host
  docker network rm "$HOST_NETWORK" >/dev/null
}

# reset-failed clears systemd's start-rate counter: one run restarts imp-host
# twice, so two runs close together would hit the limit and fail the start.
reload_unit() {
  systemctl daemon-reload
  systemctl enable -q "$1"
  systemctl reset-failed "$1" 2>/dev/null || true
  systemctl restart "$1"
}

ensure_imp() {
  phase imp
  local existing="" memtotal arc=0 budget
  [ -f "$ENV_FILE" ] && existing=$(cat "$ENV_FILE")
  memtotal=$(memtotal_kib)
  [ "$storage" = zfs ] && arc=$(zfs_arc_max_mib "$memtotal")
  budget=$(ram_budget_mib "$memtotal" "$arc")
  log "RAM: $((memtotal / 1024)) MiB, ZFS ARC cap ${arc} MiB, budget for awake imps ${budget} MiB"

  # Once the node has joined, its state keeps it on the tailnet; the key is
  # not written again (and the tailscale phase blanked it).
  local key=$authkey
  if [ -n "$key" ] && tailnet_joined; then
    log "tailscale: the node has joined already; the key is not written again"
    key=
  fi

  local env changed=
  env=$(BOOTSTRAP_AUTHKEY=$key render_env "$existing" "$(env_template | strip_markers)" "$budget" "$image" "$image_set" \
    "$storage" "$zfs_root" "$host_firewall" "$ipv6" "$ipv6_subnet" "$ksm")
  # An operator's value stays (render_env), so the floor binds the formula only.
  local refusal
  if [ "$(sed -n 's/^IMP_RAM_BUDGET_MIB=//p' <<<"$env" | tail -n 1)" = "$budget" ] \
    && ! refusal=$(check_ram_budget "$budget" "$memtotal" "$arc" "IMP_RAM_BUDGET_MIB in $ENV_FILE" 2>&1); then
    die "$refusal"
  fi
  # The image the units run: the env file's pin, else their own release's.
  # Checked before anything is written: the units run imp-docker-proxy from
  # the image and give imp-host no docker.sock, and an older image, such as
  # a stale pin that ensure_image keeps, has neither.
  if trim_lines <<<"$existing" | grep -qxF "$LEGACY_IMAGE_LINE" && [ -z "$image_set" ]; then
    log "$ENV_FILE: $LEGACY_IMAGE_LINE was the old template's line, not a pin; it becomes a comment"
  fi
  local run_image
  run_image=$(sed -n 's/^IMP_HOST_IMAGE=//p' <<<"$env" | tail -n 1)
  run_image=${run_image:-$DEFAULT_IMAGE}
  ensure_image "$run_image"
  if ! dry || docker image inspect "$run_image" >/dev/null 2>&1; then
    refusal=$(check_image_contract "$run_image" 2>&1) || die "$refusal"
  fi
  put_file "$ENV_FILE" 600 "$env" && changed=1
  put_file /etc/systemd/system/imp-host.service 644 "$(unit_imp_host | strip_markers)" && changed=1
  # imp-host reaches Docker through this proxy only (docs/architecture/host-contract.md#the-docker-socket)
  local proxy_changed=
  put_file /etc/systemd/system/imp-docker-proxy.service 644 "$(unit_imp_docker_proxy | strip_markers)" && proxy_changed=1
  if [ "$storage" = zfs ]; then
    put_file /etc/systemd/system/imp-host.service.d/zfs.conf 644 "$(unit_imp_host_zfs)" && changed=1
  fi

  # The unit's seccomp profile, from the image it runs: Docker's default plus
  # pivot_root for the jailer (docs/architecture/host-contract.md#privileges).
  # A dry run pulls nothing, so it may have no image to read.
  local seccomp
  if dry && ! docker image inspect "$run_image" >/dev/null 2>&1; then
    change "write $SECCOMP_FILE from the image" true
  else
    seccomp=$(docker run --rm "$run_image" cat "$SECCOMP_IN_IMAGE") \
      || die "$run_image has no $SECCOMP_IN_IMAGE; it predates the unprivileged host"
    put_file "$SECCOMP_FILE" 644 "$seccomp" && changed=1
  fi

  # The proxy first: imp-host starts after it, and impd's first docker call
  # needs its socket.
  if [ -n "$proxy_changed$changed" ]; then
    change "restart imp-docker-proxy" reload_unit imp-docker-proxy
    change "restart imp-host" reload_unit imp-host
  else
    ensure_service imp-docker-proxy
    ensure_service imp-host
  fi
}

# check_image_contract REF: fails, and says why, unless REF runs as these
# units expect: imp.host-contract=socket-proxy (host/Dockerfile)
check_image_contract() {
  local contract
  contract=$(docker image inspect -f '{{index .Config.Labels "imp.host-contract"}}' "$1" 2>/dev/null) || contract=
  [ "$contract" = socket-proxy ] && return 0
  echo "$1 predates the Docker socket proxy (imp.host-contract is '${contract:-none}'): pull the new image (docker pull $1) and run again; the env file and the units are unchanged" >&2
  return 1
}

ensure_image() {
  local ref=$1
  if command -v docker >/dev/null && docker image inspect "$ref" >/dev/null 2>&1; then
    log "image $ref is present"
    return
  fi
  if [ -n "$image_archive" ]; then
    [ -r "$image_archive" ] || die "cannot read $image_archive"
    change "docker load $ref from $image_archive" load_image "$ref"
  else
    change "docker pull $ref" docker pull -q "$ref"
  fi
}

load_image() {
  docker load -q -i "$image_archive" >/dev/null
  docker image inspect "$1" >/dev/null 2>&1 || die "$image_archive does not hold $1"
}

health() {
  phase health
  local name=bootstrap-check
  wait_for "impd to answer" 120 docker exec imp-host imp info
  docker exec imp-host imp info

  # Nothing may be published past loopback; the tailnet reaches impd through
  # the container's own tailscaled.
  local published
  published=$(docker port imp-host)
  if grep -vE ' -> 127\.0\.0\.1:' <<<"$published" | grep -q .; then
    die "imp-host publishes a port beyond loopback: $published"
  fi

  check_storage_live
  [ "$ipv6" != on ] || check_ipv6_live

  if tailnet_joined; then
    wait_for "the tailnet node to be Running" 120 tailscale_running
    log "health: the tailnet node is Running"
  fi

  # On a new host impd adds ubuntu:24.04 as `ubuntu` after it starts.
  wait_for "the ubuntu image" 600 has_ubuntu_image
  trap 'docker exec imp-host imp rm '"$name"' >/dev/null 2>&1 || true' EXIT
  docker exec imp-host imp rm "$name" >/dev/null 2>&1 || true
  # uname needs little memory; the default would take 2 GiB of a small host
  docker exec imp-host imp new "$name" --image ubuntu --memory 512m
  docker exec imp-host imp exec "$name" -- uname -a
  docker exec imp-host imp rm "$name"
  trap - EXIT
  log "health: impd answered; created, ran and destroyed an imp"
}

# check_storage_live: impd reports the backend the bootstrap set up, and
# with ZFS the pool is ONLINE and the dataset is what the container mounted
# on /var/lib/imp.
check_storage_live() {
  local backend
  backend=$(docker exec imp-host imp info --json | jq -r '.storage.backend // empty')
  [ "$backend" = "$storage" ] || die "impd reports storage backend '${backend:-none}', not $storage"
  if [ "$storage" = zfs ]; then
    [ "$(zpool list -H -o health "$zfs_pool")" = ONLINE ] || die "pool $zfs_pool is not ONLINE"
    local top
    top=$(docker exec imp-host findmnt -n -r -o SOURCE,FSTYPE --mountpoint "$DATA_DIR" | tail -n 1)
    [ "$top" = "$zfs_root zfs" ] || die "the container has '${top:-nothing}' on $DATA_DIR, not $zfs_root"
  fi
  log "health: impd stores imps on $storage${zfs_root:+ ($zfs_root)}"
}

# check_ipv6_live: with IPv6 on, the container has an IPv6 default route,
# and impd took it (docs/architecture/networking.md#ipv6).
check_ipv6_live() {
  [ -n "$(docker exec imp-host ip -6 route show default)" ] \
    || die "imp-host has no IPv6 default route on the $HOST_NETWORK network"
  wait_for "impd to log its IPv6 plan" 60 impd_ipv6_line
  local line
  line=$(impd_ipv6_line)
  case $line in *"ipv6: off"*) die "IPv6 is on, but $line" ;; esac
  log "health: $line"
}

impd_ipv6_line() { docker logs imp-host 2>&1 | grep -o 'impd: ipv6: .*' | tail -n 1 | grep .; }

# tailnet_joined: the host container runs and holds node state.
tailnet_joined() {
  docker exec imp-host test -s /var/lib/imp/tailscale/tailscaled.state 2>/dev/null
}

tailscale_backend() {
  docker exec imp-host tailscale --socket=/var/run/tailscale/tailscaled.sock status --json 2>/dev/null \
    | jq -r '.BackendState // empty'
}

tailscale_running() { [ "$(tailscale_backend)" = Running ]; }

# ensure_tailscale: with a key in the env file, wait for the node to join,
# then blank the key. The node state in /var/lib/imp/tailscale keeps it
# joined, and tailscale-up.sh starts tailscaled from it with no key.
ensure_tailscale() {
  grep -qE '^TAILSCALE_AUTHKEY=.+' "$ENV_FILE" || return 0
  phase tailscale
  wait_for "the tailnet node to be Running" 180 tailscale_running
  # An older image skips tailscaled without a key, which would take the
  # node off the tailnet at its next start.
  if [ "$(docker container inspect -f '{{index .Config.Labels "imp.tailscale-keyless"}}' imp-host)" != 1 ]; then
    warn "this imp-host image needs TAILSCALE_AUTHKEY at every start; the key stays in $ENV_FILE"
    return 0
  fi
  change "blank TAILSCALE_AUTHKEY in $ENV_FILE; the node state keeps it joined" \
    write_file "$ENV_FILE" 600 "$(blank_env_key <"$ENV_FILE")"
  # The running container still holds the key in its environment (docker
  # inspect, /proc/*/environ); a restart with the blank file drops it.
  change "restart imp-host without the key" reload_unit imp-host
}

# blank_env_key: the env file on stdin with TAILSCALE_AUTHKEY emptied.
blank_env_key() { sed 's/^TAILSCALE_AUTHKEY=.*/TAILSCALE_AUTHKEY=/'; }

has_ubuntu_image() { docker exec imp-host imp image ls 2>/dev/null | grep -q '^ubuntu '; }

# wait_for WHAT SECONDS CMD...: retry CMD once a second until it succeeds.
wait_for() {
  local what=$1 seconds=$2 i
  shift 2
  for i in $(seq "$seconds"); do
    "$@" >/dev/null 2>&1 && return 0
    [ "$i" = "$seconds" ] || sleep 1
  done
  die "gave up waiting ${seconds} s for $what; see journalctl -u imp-host"
}

main() {
  parse_args "$@"
  preflight
  ensure_packages
  ensure_storage
  ensure_kernel
  ensure_ksm
  ensure_firewall
  ensure_ipv6
  ensure_imp
  if dry; then
    log "$changes change(s) pending"
    [ "$mode" = check ] && [ "$changes" -gt 0 ] && exit 2
    exit 0
  fi
  ensure_tailscale
  log "$changes change(s) made"
  if [ -n "$authkey_file" ]; then
    log "delete $authkey_file now; the key is not needed again (docs/guides/install.md#the-tailscale-key)"
  fi
  [ -n "$skip_health" ] || health
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
