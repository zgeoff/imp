#!/bin/bash
# Take a fresh Ubuntu 24.04 or 26.04, or Debian 13, server to a running imp host
# (docs/guides/install.md, "Bootstrap a server"). Run as root:
#
#   bootstrap.sh --yes --data-device /dev/nvme1n1
#   bootstrap.sh --yes --loop-file /srv/imp.xfs                # sized from the free space
#   bootstrap.sh --check --data-device /dev/nvme1n1   # exit 2 if a run would change anything
#   bootstrap.sh --yes --storage zfs --data-device /dev/nvme1n1
#
# Phases, in order: preflight, packages, storage, kernel, firewall, imp,
# health. Each phase compares the host with what it wants and changes only
# the difference, so a second run changes nothing. --dry-run prints the
# changes instead of making them.
#
# The script is self-contained, so it runs on a server without a checkout:
# it embeds deploy/imp-host.service and deploy/imp-host.env.example (a test
# keeps the copies equal to those files).
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
  --image REF                 host image (default ghcr.io/zgeoff/imp-host:latest)
  --image-archive FILE        docker load FILE when REF is missing, instead of a pull
  --tailscale-authkey-file F  a tagged auth key for the host container's node
                              (or TAILSCALE_AUTHKEY in the environment)
  --ssh-port N                one more SSH port to keep open (repeatable)
  --skip-health               skip the closing health check
EOF
}

readonly IMP_DIR=/etc/imp
readonly ENV_FILE=$IMP_DIR/imp-host.env
readonly FIREWALL_FILE=$IMP_DIR/firewall.nft
readonly DATA_DIR=/var/lib/imp
readonly DEFAULT_IMAGE=ghcr.io/zgeoff/imp-host:latest
# Docker's apt signing key (https://docs.docker.com/engine/install/ubuntu/).
readonly DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# The template's IMP_RAM_BUDGET_MIB; a file still holding it gets the
# computed budget, any other value is the operator's and stays.
readonly TEMPLATE_BUDGET_MIB=16384
# A loop file smaller than this is refused.
readonly LOOP_MIN_GIB=20

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
extra_ssh_ports=()
skip_health=
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

# ram_budget_mib MEMTOTAL_KIB [ARC_MIB]: the RAM awake imps may use. The
# host keeps the larger of 8 GiB and 15 % for itself, Docker, impd and the
# page cache, and with ZFS also the ARC's cap.
ram_budget_mib() {
  local total=$(($1 / 1024)) arc=${2:-0} reserve
  reserve=$((total * 15 / 100))
  [ "$reserve" -lt 8192 ] && reserve=8192
  echo $((total - reserve - arc))
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
# start, because nothing is mounted.
fstab_line() {
  case $2 in
    device) printf '%s %s xfs defaults,nofail 0 2\n' "$1" "$DATA_DIR" ;;
    loop) printf '%s %s xfs loop,nofail 0 0\n' "$1" "$DATA_DIR" ;;
  esac
}

# ssh_ports_from_sshd_t: ports from `sshd -T` output on stdin.
ssh_ports_from_sshd_t() { awk 'tolower($1) == "port" { print $2 }'; }

# ssh_ports_from_listen: ports from systemd socket Listen= values or `ss`
# local addresses on stdin, such as "[::]:22 (Stream)" or "0.0.0.0:2222".
ssh_ports_from_listen() { grep -oE ':[0-9]+( |$)' | tr -d ': '; }

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

# render_env EXISTING TEMPLATE BUDGET IMAGE IMAGE_SET STORAGE ZFS_ROOT:
# imp-host.env with bootstrap's keys set. EXISTING (empty when there is no
# file) wins over TEMPLATE; the operator's other lines stay. IMP_HOST_IMAGE
# is set when IMAGE_SET is non-empty or the file is new, IMP_RAM_BUDGET_MIB
# when it is empty or still the template's, IMP_STORAGE_BACKEND always, and
# IMP_ZFS_ROOT when ZFS_ROOT is non-empty. TAILSCALE_AUTHKEY comes from the
# environment variable BOOTSTRAP_AUTHKEY, never from argv, and is set when
# non-empty.
render_env() {
  local base=$1 template=$2 budget=$3 img=$4 img_set=$5
  [ -z "$base" ] && base=$template && img_set=1
  BUDGET=$budget IMG=$img IMG_SET=$img_set TEMPLATE_BUDGET=$TEMPLATE_BUDGET_MIB \
    STORAGE=$6 ZFS_ROOT=$7 \
    awk '
      function set(key, value) { print key "=" value; done[key] = 1 }
      /^IMP_HOST_IMAGE=/ && ENVIRON["IMG_SET"] != "" { set("IMP_HOST_IMAGE", ENVIRON["IMG"]); next }
      /^IMP_STORAGE_BACKEND=/ { set("IMP_STORAGE_BACKEND", ENVIRON["STORAGE"]); next }
      /^IMP_ZFS_ROOT=/ && ENVIRON["ZFS_ROOT"] != "" { set("IMP_ZFS_ROOT", ENVIRON["ZFS_ROOT"]); next }
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
      }
    ' <<<"$base"
}

# --- embedded deploy files: keep equal to deploy/ (the test checks) ---

unit_imp_host() {
  cat <<'EOF'
# imp host as a systemd service. One of the two supported ways to run the
# release image; deploy/compose.yaml is the other. Run one, not both.
#
#   install -m 0644 deploy/imp-host.service /etc/systemd/system/
#   install -D -m 0600 deploy/imp-host.env.example /etc/imp/imp-host.env  # then edit
#   systemctl daemon-reload && systemctl enable --now imp-host
#   deploy/upgrade.sh   to a new image
#
# /var/lib/imp must be XFS with reflink (docs/guides/install.md).
[Unit]
Description=imp host (impd, Firecracker, tailscaled)
Documentation=https://github.com/zgeoff/imp/blob/main/docs/guides/install.md
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
# With XFS, /var/lib/imp is a host mount; never start before it is there.
RequiresMountsFor=/var/lib/imp

[Service]
Type=exec
Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest
EnvironmentFile=/etc/imp/imp-host.env
# A container left over from a crash would hold the name.
ExecStartPre=-/usr/bin/docker rm -f imp-host
# In the foreground and without a docker restart policy: systemd supervises
# it and restarts it on failure.
ExecStart=/usr/bin/docker run --rm --name imp-host \
  --init --privileged --device /dev/kvm \
  --env-file /etc/imp/imp-host.env \
  -v /var/lib/imp:/var/lib/imp \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -p 127.0.0.1:7070:7070 -p 127.0.0.1:7080:7080 \
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

env_template() {
  cat <<'EOF'
# imp host settings. Copy to /etc/imp/imp-host.env (mode 0600: it holds the
# Tailscale key and the DNS token). Both deploy/imp-host.service and deploy/compose.yaml pass
# it to the container. docs/guides/configuration.md lists every variable.
#
# docker --env-file format: KEY=value, one per line, no quotes, no
# expansion. An empty value counts as unset.

# The image to run. The systemd unit reads it; compose reads it from the
# shell or a .env next to compose.yaml.
IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest

# A tagged, non-ephemeral auth key (docs/guides/tailscale.md). Without one
# the host is local-only: the API listens on 127.0.0.1:7070 and no imp is
# reachable from elsewhere.
TAILSCALE_AUTHKEY=
IMP_TAILSCALE_HOSTNAME=imp

# HTTPS on your own domain (docs/guides/https.md): every imp at
# https://<name>.<domain> on the tailnet. The token is a Cloudflare API token
# with Zone:Read and DNS:Edit on the zone.
IMP_DOMAIN=
IMP_DNS_PROVIDER=cloudflare
IMP_DNS_API_TOKEN=
IMP_ACME_EMAIL=

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
        shift
        ;;
      --ssh-port) extra_ssh_ports+=("${2:?--ssh-port needs a port}") && shift ;;
      --skip-health) skip_health=1 ;;
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
  if [ "$storage" = xfs ] && [ -z "$data_device" ] && [ -z "$loop_file" ] && ! mountpoint -q "$DATA_DIR"; then
    die "$DATA_DIR is not mounted; give --data-device DEV or --loop-file PATH"
  fi
  if [ -z "$authkey" ]; then
    warn "no Tailscale key: the host stays local-only (docs/guides/tailscale.md)"
  fi
}

# resolve_storage: the backend and the ZFS dataset, from the flags, else
# the env file, so a later run without --storage keeps what the first chose.
resolve_storage() {
  local env_storage="" env_root=""
  if [ -f "$ENV_FILE" ]; then
    env_storage=$(sed -n 's/^IMP_STORAGE_BACKEND=//p' "$ENV_FILE" | tail -n 1)
    env_root=$(sed -n 's/^IMP_ZFS_ROOT=//p' "$ENV_FILE" | tail -n 1)
  fi
  storage=${storage:-${env_storage:-xfs}}
  if [ -n "$env_storage" ] && [ "$storage" != "$env_storage" ]; then
    die "$ENV_FILE says IMP_STORAGE_BACKEND=$env_storage; switching backends would leave every imp behind"
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
    die "$ENV_FILE says IMP_ZFS_ROOT=$env_root, not $zfs_root"
  fi
  if mountpoint -q "$DATA_DIR"; then
    die "$DATA_DIR is a mount on the host; with ZFS the container mounts $zfs_root there itself"
  fi
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
  if grep -qE "^[^#]*[[:space:]]${DATA_DIR}[[:space:]]" /etc/fstab; then
    grep -qxF "$line" /etc/fstab \
      || die "/etc/fstab has another entry for $DATA_DIR; fix or remove it first"
    return
  fi
  change "add $DATA_DIR to /etc/fstab" append_line /etc/fstab "$line"
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
    [ -d "/sys/module/$mod" ] || change "modprobe $mod" modprobe "$mod"
  done
  local arc_param=/sys/module/zfs/parameters/zfs_arc_max
  if [ -n "$arc_bytes" ] && [ "$(cat "$arc_param" 2>/dev/null)" != "$arc_bytes" ]; then
    change "set zfs_arc_max to $arc_bytes" write_param "$arc_param" "$arc_bytes"
  fi
  local swap
  swap=$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  log "swap: ${swap} MiB, left as it is"
}

write_param() { echo "$2" >"$1"; }

memtotal_kib() { awk '/^MemTotal:/ { print $2 }' /proc/meminfo; }

ensure_firewall() {
  phase firewall
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

reload_unit() {
  systemctl daemon-reload
  systemctl enable -q "$1"
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
  env=$(BOOTSTRAP_AUTHKEY=$key render_env "$existing" "$(env_template)" "$budget" "$image" "$image_set" \
    "$storage" "$zfs_root")
  put_file "$ENV_FILE" 600 "$env" && changed=1
  put_file /etc/systemd/system/imp-host.service 644 "$(unit_imp_host)" && changed=1
  if [ "$storage" = zfs ]; then
    put_file /etc/systemd/system/imp-host.service.d/zfs.conf 644 "$(unit_imp_host_zfs)" && changed=1
  fi

  # The image the unit runs: the env file's, which an operator may pin.
  local run_image
  run_image=$(sed -n 's/^IMP_HOST_IMAGE=//p' <<<"$env" | tail -n 1)
  ensure_image "${run_image:-$DEFAULT_IMAGE}"

  if [ -n "$changed" ]; then
    change "restart imp-host" reload_unit imp-host
  else
    ensure_service imp-host
  fi
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

  if tailnet_joined; then
    wait_for "the tailnet node to be Running" 120 tailscale_running
    log "health: the tailnet node is Running"
  fi

  # On a new host impd adds ubuntu:24.04 as `ubuntu` after it starts.
  wait_for "the ubuntu image" 600 has_ubuntu_image
  trap 'docker exec imp-host imp rm '"$name"' >/dev/null 2>&1 || true' EXIT
  docker exec imp-host imp rm "$name" >/dev/null 2>&1 || true
  docker exec imp-host imp new "$name" --image ubuntu
  docker exec imp-host imp exec "$name" -- uname -a
  docker exec imp-host imp rm "$name"
  trap - EXIT
  log "health: impd answered; created, ran and destroyed an imp"
}

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
  if ! docker exec imp-host grep -q 'saved node state' /usr/local/lib/imp/tailscale-up.sh; then
    warn "this imp-host image needs TAILSCALE_AUTHKEY at every start; the key stays in $ENV_FILE"
    return 0
  fi
  change "blank TAILSCALE_AUTHKEY in $ENV_FILE; the node state keeps it joined" \
    write_file "$ENV_FILE" 600 "$(blank_env_key <"$ENV_FILE")"
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
  ensure_firewall
  ensure_imp
  if dry; then
    log "$changes change(s) pending"
    [ "$mode" = check ] && [ "$changes" -gt 0 ] && exit 2
    exit 0
  fi
  ensure_tailscale
  log "$changes change(s) made"
  [ -n "$skip_health" ] || health
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
