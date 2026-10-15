# shellcheck shell=bash
# The imp, tailscale and health phases: the env file, the units, the
# image, and the checks once imp-host runs.

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
  if [ "$(sed -n 's/^IMP_RAM_BUDGET_MIB=//p' <<<"$env" | tail -n 1)" = "$budget" ] &&
    ! refusal=$(check_ram_budget "$budget" "$memtotal" "$arc" "IMP_RAM_BUDGET_MIB in $ENV_FILE" 2>&1); then
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
  # imp-host reaches Docker through this proxy only (docs/architecture/host.md#the-docker-socket)
  local proxy_changed=
  put_file /etc/systemd/system/imp-docker-proxy.service 644 "$(unit_imp_docker_proxy | strip_markers)" && proxy_changed=1
  if [ "$storage" = zfs ]; then
    put_file /etc/systemd/system/imp-host.service.d/zfs.conf 644 "$(unit_imp_host_zfs)" && changed=1
  fi

  # The unit's seccomp profile, from the image it runs: Docker's default plus
  # pivot_root for the jailer (docs/architecture/host.md#privileges).
  # A dry run pulls nothing, so it may have no image to read.
  local seccomp
  if dry && ! docker image inspect "$run_image" >/dev/null 2>&1; then
    change "write $SECCOMP_FILE from the image" true
  else
    seccomp=$(read_seccomp "$run_image") || exit 1
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

# read_seccomp REF: the seccomp profile in the image REF; refuses an image
# without one.
read_seccomp() {
  docker run --rm "$1" cat "$SECCOMP_IN_IMAGE" ||
    die "$1 has no $SECCOMP_IN_IMAGE; it predates the unprivileged host"
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

# The CLI in the imp-host container: impz, or imp in an image from before the
# CLI's rename that --image or an IMP_HOST_IMAGE pin chose. Asked on each call,
# since the container may restart onto another image in between.
host_cli() {
  if docker exec imp-host impz --version >/dev/null 2>&1; then
    docker exec imp-host impz "$@"
  else
    docker exec imp-host imp "$@"
  fi
}

health() {
  phase health
  local name=bootstrap-check
  wait_for "impd to answer" 120 host_cli info
  host_cli info

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
  trap 'host_cli rm '"$name"' >/dev/null 2>&1 || true' EXIT
  host_cli rm "$name" >/dev/null 2>&1 || true
  # uname needs little memory; the default would take 2 GiB of a small host
  host_cli new "$name" --image ubuntu --memory 512m
  host_cli exec "$name" -- uname -a
  host_cli rm "$name"
  trap - EXIT
  log "health: impd answered; created, ran and destroyed an imp"
}

# check_storage_live: impd reports the backend the bootstrap set up, and
# with ZFS the pool is ONLINE and the dataset is what the container mounted
# on /var/lib/imp.
check_storage_live() {
  local backend
  backend=$(host_cli info --json | jq -r '.storage.backend // empty')
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
# and impd took it (docs/architecture/network/networking.md#ipv6).
check_ipv6_live() {
  [ -n "$(docker exec imp-host ip -6 route show default)" ] ||
    die "imp-host has no IPv6 default route on the $HOST_NETWORK network"
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
  docker exec imp-host tailscale --socket=/var/run/tailscale/tailscaled.sock status --json 2>/dev/null |
    jq -r '.BackendState // empty'
}

tailscale_running() { [ "$(tailscale_backend)" = Running ]; }

has_ubuntu_image() { host_cli image ls 2>/dev/null | grep -q '^ubuntu '; }

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
