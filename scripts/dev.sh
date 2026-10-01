#!/bin/bash
# Run impd in one long-lived dev host container (imp-dev).
#
#   scripts/dev.sh up        build what is missing, start the container, wait for impd
#   scripts/dev.sh down      remove the container (VMs stop; data stays in .data/dev)
#   scripts/dev.sh logs      follow the container log
#   scripts/dev.sh restart   restart impd only; running VMs survive and are re-adopted
#   scripts/dev.sh shell     open a shell in the container
#   scripts/dev.sh token     print the API token (for IMP_TOKEN)
#
# Env: IMP_DEV_NAME (default imp-dev) names the container; IMP_DEV_PORT_OFFSET
#      (default 0) shifts every published port, so parallel dev instances (one
#      per git worktree) can run side by side.
#      IMP_DEV_DATA (default <repo>/.data/dev) holds the sparse XFS file.
#      IMP_KERNEL (default kernel/out/vmlinux, else .cache/vmlinux-ci) is the guest kernel.
#      IMP_SYSTEM_DRIVE (default build/imp-system.squashfs) is the system drive.
#      Both are repo-relative or absolute paths under the repo.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

name=${IMP_DEV_NAME:-imp-dev}
offset=${IMP_DEV_PORT_OFFSET:-0}
data=${IMP_DEV_DATA:-$IMP_ROOT/.data/dev}
api=http://localhost:$((7070 + offset))

# in_container PATH maps a path under the repo to its /src path.
in_container() {
  local abs
  abs=$(realpath -m "$1")
  case $abs in
    "$IMP_ROOT"/*) echo "/src/${abs#"$IMP_ROOT"/}" ;;
    *) echo "dev.sh: $1 is not under $IMP_ROOT" >&2; return 1 ;;
  esac
}

pick_kernel() {
  if [ -n "${IMP_KERNEL:-}" ]; then
    echo "$IMP_KERNEL"
  elif [ -f "$IMP_ROOT/kernel/out/vmlinux" ]; then
    echo "$IMP_ROOT/kernel/out/vmlinux"
  else
    echo "$IMP_ROOT/.cache/vmlinux-ci"
  fi
}

# read_uplink_mtu prints the MTU of this machine's default-route interface;
# the container's own eth0 claims 1500 whatever the real path allows.
read_uplink_mtu() {
  local dev
  dev=$(ip route show default | awk '{print $5; exit}')
  cat "/sys/class/net/$dev/mtu" 2>/dev/null || echo 1500
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = true ]
}

# wait_ready waits until /health reports ready (default image seeded).
wait_ready() {
  local deadline=$((SECONDS + ${1:-600}))
  until curl -fsS "$api/health" 2>/dev/null | grep -q '"ready":true'; do
    if ! is_running; then
      echo "dev.sh: $name stopped; last log lines:" >&2
      docker logs --tail 40 "$name" >&2 || true
      return 1
    fi
    if [ $SECONDS -ge $deadline ]; then
      echo "dev.sh: impd not ready after ${1:-600}s" >&2
      return 1
    fi
    sleep 0.5
  done
}

up() {
  local kernel system
  kernel=$(pick_kernel)
  system=${IMP_SYSTEM_DRIVE:-$IMP_BUILD/imp-system.squashfs}
  [ -f "$kernel" ] || { echo "dev.sh: no kernel at $kernel" >&2; exit 1; }

  docker build -q -t "$IMP_HOST_IMAGE" "$IMP_ROOT/host" >/dev/null
  if [ ! -f "$system" ]; then
    echo "dev.sh: building the system drive"
    "$IMP_ROOT/scripts/build-system-drive.sh" >/dev/null
  fi

  if is_running; then
    echo "dev.sh: $name already running"
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    mkdir -p "$data"
    # .env holds TAILSCALE_AUTHKEY; docker reads it, so it is never echoed
    local env_file=()
    [ -f "$IMP_ROOT/.env" ] && env_file=(--env-file "$IMP_ROOT/.env")
    # The repo is also mounted at its own path, so `imp image build <dir>`
    # paths the CLI resolves on this machine exist in the container.
    # Own resolvers: the WSL host's 100.100.100.100 stops answering once the
    # container's own tailscaled starts.
    docker run -d --name "$name" --init --privileged --device /dev/kvm \
      --dns 1.1.1.1 --dns 8.8.8.8 "${env_file[@]}" \
      -v "$IMP_ROOT:/src" -v "$IMP_ROOT:$IMP_ROOT" -v "$data:/data" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -p $((7070 + offset)):7070 -p $((7080 + offset)):7080 \
      -p $((20000 + offset))-$((20063 + offset)):20000-20063 \
      -e IMP_STORAGE_GIB="${IMP_STORAGE_GIB:-200}" \
      -e IMP_UPLINK_MTU="$(read_uplink_mtu)" \
      -e IMP_KERNEL="$(in_container "$kernel")" \
      -e IMP_SYSTEM_DRIVE="$(in_container "$system")" \
      -e IMP_DEFAULT_IMAGE="${IMP_DEFAULT_IMAGE:-}" \
      "$IMP_HOST_IMAGE" >/dev/null
    echo "dev.sh: started $name"
  fi
  wait_ready
  echo "dev.sh: impd ready on $api (token: scripts/dev.sh token)"
}

case ${1:-} in
  up) up ;;
  down) docker rm -f "$name" >/dev/null 2>&1 || true ;;
  logs) docker logs -f "$name" ;;
  restart)
    docker exec "$name" pkill -TERM -f 'bun .*/daemon/src/main.ts' || true
    sleep 1
    wait_ready 60
    ;;
  shell) docker exec -it "$name" bash ;;
  token) docker exec "$name" cat /var/lib/imp/token ;;
  *)
    echo "usage: $0 up|down|logs|restart|shell|token" >&2
    exit 2
    ;;
esac
