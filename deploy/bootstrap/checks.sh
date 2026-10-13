# shellcheck shell=bash
# The preflight phase: the flags, the platform, and the choices a run
# keeps in the env file (storage, host firewall, IPv6).

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
                              guests time each other (docs/architecture/lifecycle/ram-governor.md#ksm).
  --no-ksm                    turn it off again: remove the boot rule, stop
                              ksmd, unmerge its pages and set IMP_KSM=0;
                              running imps keep the merge flag until they
                              restart
  --skip-health               skip the closing health check
EOF
}

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
  check_platform

  resolve_storage
  resolve_host_firewall
  resolve_ipv6
  # --image writes the line again; without it the units would run no image
  if [ -z "$image_set" ]; then
    local refusal
    refusal=$(check_env_image "$ENV_FILE" 2>&1) || die "$refusal; or pass --image"
  fi
  check_data_source
  if [ -z "$authkey" ] && ! tailnet_joined; then
    warn "no Tailscale key: the host stays local-only (docs/guides/tailscale.md)"
  fi
}

# check_platform [OSRELEASE] [OS_RELEASE] [KVM] [CPUINFO]: a supported OS on
# x86_64 with KVM, not WSL. The arguments default to the kernel's and the OS's
# own files.
check_platform() {
  local osrelease=${1:-/proc/sys/kernel/osrelease} os_release=${2:-/etc/os-release}
  local kvm=${3:-/dev/kvm} cpuinfo=${4:-/proc/cpuinfo}
  # The dev box is WSL2 Ubuntu; a stray run there must not touch it. A test
  # container on that box shares its kernel but is allowed (preflight).
  if grep -qi microsoft "$osrelease" && [ -z "$in_container" ]; then
    die "refusing to run on WSL; this script is for a bare-metal server"
  fi

  # shellcheck source=/dev/null
  . "$os_release"
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:24.04 | ubuntu:26.04 | debian:13) log "OS: $PRETTY_NAME" ;;
    *) die "unsupported OS ${PRETTY_NAME:-unknown}; use Ubuntu 24.04 or 26.04, or Debian 13" ;;
  esac
  [ "$(uname -m)" = x86_64 ] || die "the host image is x86_64 only"

  [ -c "$kvm" ] || die "$kvm is missing; enable VT-x/AMD-V in the firmware"
  grep -qwE 'vmx|svm' "$cpuinfo" || die "the CPU reports neither vmx nor svm"
}

# check_data_source: XFS needs a device, a loop file, or a mount already on
# $DATA_DIR.
check_data_source() {
  if [ "$storage" = xfs ] && [ -z "$data_device" ] && [ -z "$loop_file" ] && ! mountpoint -q "$DATA_DIR"; then
    die "$DATA_DIR is not mounted; give --data-device DEV or --loop-file PATH"
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

# resolve_host_firewall [ENV_FILE]: the flag, else the env file (default
# $ENV_FILE), else own.
resolve_host_firewall() {
  local env_file=${1:-$ENV_FILE} env_value=""
  [ -f "$env_file" ] && env_value=$(sed -n 's/^IMP_HOST_FIREWALL=//p' "$env_file" | tail -n 1)
  host_firewall=${host_firewall:-${env_value:-own}}
  case $host_firewall in own | none) ;; *) die "$env_file says IMP_HOST_FIREWALL=$host_firewall; want own or none" ;; esac
  log "host firewall: $host_firewall"
}

# resolve_ipv6 [ENV_FILE]: the flag, else the env file's (default
# $ENV_FILE) choice, else auto. The env file keeps on or off, never auto,
# so a later run on a host whose IPv6 route is down for a moment does not
# take imps' IPv6 away.
resolve_ipv6() {
  local env_file=${1:-$ENV_FILE} env_value="" uplink
  [ -f "$env_file" ] && env_value=$(sed -n 's/^IMP_HOST_IPV6=//p' "$env_file" | tail -n 1)
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
    *) die "$env_file says IMP_HOST_IPV6=$ipv6; want on or off" ;;
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
