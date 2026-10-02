#!/bin/bash
# Run impd in one long-lived dev host container (imp-dev).
#
#   scripts/dev.sh up        build what is missing, start the container, wait for impd
#   scripts/dev.sh down      stop the container (impd sleeps every imp first, so
#                            memory survives) and remove it; data stays in .data/dev
#   scripts/dev.sh reboot    down, then up: imps come back asleep and wake on demand
#   scripts/dev.sh logs      follow the container log
#   scripts/dev.sh restart   restart impd only (SIGHUP); running VMs survive and are re-adopted
#   scripts/dev.sh shell     open a shell in the container
#   scripts/dev.sh token     print the API token (for IMP_TOKEN)
#
# Env: IMP_DEV_NAME (default imp-dev) names the container; IMP_DEV_PORT_OFFSET
#      (default 0) shifts every published port, so parallel dev instances (one
#      per git worktree) can run side by side.
#      IMP_DEV_DATA (default <repo>/.data/dev) holds the sparse XFS file.
#      IMP_KERNEL (default kernel/out/vmlinux, else .cache/vmlinux-ci) is the guest kernel.
#      IMP_SYSTEM_DRIVE (default build/imp-system.squashfs) is the system drive.
#      Without it, every up rebuilds the default drive from agent/; the docker
#      cache makes that a no-op when the agent is unchanged.
#      Both are repo-relative or absolute paths under the repo.
#      IMP_HOST_IMAGE_READY=1 uses the host image as it is instead of building
#      it (CI builds and loads it first, with its own cache).
#      Tuning passed through to impd when set: IMP_IDLE_TIMEOUT_S,
#      IMP_IDLE_CPU_PERCENT, IMP_RAM_BUDGET_MIB, IMP_BOOT_RESERVE_PERCENT,
#      IMP_WAKE_RESERVE_MIB, IMP_SLEEP_MIN_GUEST_UPTIME_MS, IMP_DEFAULT_VCPUS,
#      IMP_DEFAULT_MEMORY_MIB, IMP_DEFAULT_DISK_GIB, IMP_DISK_RESERVE_GIB, IMP_TAILSCALE_HOSTNAME,
#      IMP_BUILD_CONTEXT_MAX_MIB, IMP_WATCHDOG_TIMEOUT_S, IMP_WATCHDOG_ACTION, IMP_SUBNET6,
#      IMP_BOOT_TEMPLATES, IMP_JAILER.
#      IMP_STORAGE_BACKEND=zfs with IMP_ZFS_ROOT runs on a ZFS dataset instead
#      of the XFS file (scripts/zfs-host-test.sh; the host needs the module).
#      IMP_BROKER_PORT moves the credential broker. A dev instance always reads
#      <IMP_DEV_DATA>/broker-test-upstreams.json when it exists: the fake
#      upstreams the connectors suite puts in for granted hosts.
#      HTTPS (docs/guides/https.md) passes through the same way: IMP_DOMAIN,
#      IMP_DNS_PROVIDER, IMP_DNS_API_URL, IMP_ACME_DIRECTORY, IMP_ACME_EMAIL,
#      IMP_HTTPS_PORT, IMP_HTTP_PORT, the IMP_PUBLIC_* settings of public imps,
#      and IMP_ACME_CA_FILE as a path under the repo. IMP_DNS_API_TOKEN, a
#      secret, goes in .env. The public listeners are not published.
#      IMP_TAILNET_NAMES=1 turns on per-imp tailnet names, with
#      IMP_TAILNET_NAME_PREFIX; the OAuth client comes from 1Password
#      (write_tailnet_oauth_file in scripts/lib.sh) into <IMP_DEV_DATA>.
#      TAILSCALE_AUTHKEY comes from the env, else 1Password
#      (IMP_TAILSCALE_AUTHKEY_REF, default op://cloud/imp-tailscale-authkey/credential),
#      else .env; see load_tailscale_authkey in scripts/lib.sh.
#      IMP_DEV_NETWORK puts the container on that Docker network, and IMP_E2E=1
#      lets impd use the challtestsrv DNS provider (the e2e harness's Pebble).
#      IMP_DEV_IP gives the container that address on IMP_DEV_NETWORK.
#      IMP_DEV_PUBLISH=0 publishes no ports: impd answers on IMP_DEV_IP:7070
#      only, as the moves suite's second host does. IMP_DEV_TAILNET=0 keeps
#      the container off the tailnet whatever key there is.
#      IMP_MOVE_TEST_CIDR and IMP_PEER_URL pass through for the moves suite.
#      IMP_UPLINK_MTU overrides the MTU read from this machine's default route.
#      IMP_BACKUP_* pass through too (docs/architecture/backups.md), and
#      IMP_DEV_BACKUP_ENV_FILE is a docker --env-file with the repository's
#      AWS_* keys, so this shell's own AWS_* never reach the container.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

name=${IMP_DEV_NAME:-imp-dev}
offset=${IMP_DEV_PORT_OFFSET:-0}
data=${IMP_DEV_DATA:-$IMP_ROOT/.data/dev}
publish=${IMP_DEV_PUBLISH:-1}
api=http://localhost:$((7070 + offset))
if [ "$publish" = 0 ]; then
  [ -n "${IMP_DEV_IP:-}" ] || { echo "dev.sh: IMP_DEV_PUBLISH=0 needs IMP_DEV_IP" >&2; exit 1; }
  api=http://$IMP_DEV_IP:7070
fi

# an allowlist: IMP_URL, IMP_TOKEN and IMP_DEV_* belong to this machine
tuning_vars=(IMP_IDLE_TIMEOUT_S IMP_IDLE_CPU_PERCENT IMP_RAM_BUDGET_MIB IMP_BOOT_RESERVE_PERCENT
  IMP_WAKE_RESERVE_MIB IMP_SLEEP_MIN_GUEST_UPTIME_MS IMP_DEFAULT_VCPUS IMP_DEFAULT_MEMORY_MIB
  IMP_DEFAULT_DISK_GIB IMP_DISK_RESERVE_GIB IMP_TAILSCALE_HOSTNAME IMP_TAILNET_IDENTITIES
  IMP_TAILNET_NAMES IMP_TAILNET_NAME_PREFIX IMP_BUILD_CONTEXT_MAX_MIB
  IMP_WATCHDOG_TIMEOUT_S IMP_WATCHDOG_ACTION
  IMP_SSH_AUTHORIZED_KEYS IMP_STORAGE_BACKEND IMP_ZFS_ROOT IMP_SUBNET6
  IMP_DOMAIN IMP_DNS_PROVIDER IMP_DNS_API_URL IMP_ACME_DIRECTORY IMP_ACME_EMAIL IMP_HTTPS_PORT
  IMP_HTTP_PORT IMP_PUBLIC_IP IMP_PUBLIC_HTTPS_PORT IMP_PUBLIC_HTTP_PORT IMP_E2E IMP_BROKER_PORT
  IMP_BACKUP_REPOSITORY IMP_BACKUP_PASSWORD_FILE
  IMP_BACKUP_INTERVAL_S IMP_BACKUP_KEEP IMP_BACKUP_FORGET IMP_BACKUP_CPUS IMP_BACKUP_MEMORY_MIB
  IMP_BOOT_TEMPLATES IMP_JAILER IMP_JAILER_BIN IMP_MOVE_TEST_CIDR IMP_PEER_URL)

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

  if [ "${IMP_HOST_IMAGE_READY:-}" = 1 ]; then
    docker image inspect "$IMP_HOST_IMAGE" >/dev/null 2>&1 \
      || { echo "dev.sh: IMP_HOST_IMAGE_READY=1 but there is no $IMP_HOST_IMAGE image" >&2; exit 1; }
  else
    docker build -q -t "$IMP_HOST_IMAGE" --target dev -f "$IMP_ROOT/host/Dockerfile" "$IMP_ROOT" >/dev/null
  fi
  if [ -z "${IMP_SYSTEM_DRIVE:-}" ]; then
    "$IMP_ROOT/scripts/build-system-drive.sh" >/dev/null
  fi
  [ -f "$system" ] || { echo "dev.sh: no system drive at $system" >&2; exit 1; }

  if is_running; then
    echo "dev.sh: $name already running"
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    mkdir -p "$data"
    # docker reads .env itself, so its secrets are never echoed
    local env_file=() tuning=() var
    [ -f "$IMP_ROOT/.env" ] && env_file=(--env-file "$IMP_ROOT/.env")
    # the Tailscale key from the env, 1Password or .env (lib.sh); -e with no
    # value copies it from this environment, so it never lands in argv
    if [ "${IMP_DEV_TAILNET:-}" = 0 ]; then
      # empty overrides a key in .env: impd reads it as unset
      tuning+=(-e TAILSCALE_AUTHKEY=)
    elif load_tailscale_authkey; then
      tuning+=(-e TAILSCALE_AUTHKEY)
    fi
    [ -n "${IMP_DEV_BACKUP_ENV_FILE:-}" ] && env_file+=(--env-file "$IMP_DEV_BACKUP_ENV_FILE")
    if [ "${IMP_TAILNET_NAMES:-}" = 1 ]; then
      write_tailnet_oauth_file "$data/tailnet-oauth.json" \
        || { echo "dev.sh: IMP_TAILNET_NAMES=1 but 1Password has no OAuth client" >&2; exit 1; }
      tuning+=(-e IMP_TAILNET_OAUTH_FILE=/data/tailnet-oauth.json)
    fi
    for var in "${tuning_vars[@]}"; do
      [ -n "${!var:-}" ] && tuning+=(-e "$var=${!var}")
    done
    if [ -n "${IMP_ACME_CA_FILE:-}" ]; then
      tuning+=(-e "IMP_ACME_CA_FILE=$(in_container "$IMP_ACME_CA_FILE")")
    fi
    local network=() ports=()
    [ -n "${IMP_DEV_NETWORK:-}" ] && network=(--network "$IMP_DEV_NETWORK")
    [ -n "${IMP_DEV_IP:-}" ] && network+=(--ip "$IMP_DEV_IP")
    if [ "$publish" != 0 ]; then
      ports=(-p $((7070 + offset)):7070 -p $((7080 + offset)):7080
        -p $((20000 + offset))-$((20063 + offset)):20000-20063
        -p 127.0.0.1:$((2222 + offset)):22)
    fi
    # The repo is also mounted at its own path, so `imp image build <dir>`
    # paths the CLI resolves on this machine exist in the container.
    # Own resolvers: the WSL host's 100.100.100.100 stops answering once the
    # container's own tailscaled starts.
    # a fixed hostname: restic counts a lock stale at once only when it
    # holds this host's name and a dead pid
    # a private cgroup namespace: impd puts each imp's Firecracker in its own
    # cgroup for CPU limits (host/scripts/setup-cgroups.sh)
    docker run -d --name "$name" --hostname "$name" --init --privileged --device /dev/kvm \
      --cgroupns=private \
      --dns 1.1.1.1 --dns 8.8.8.8 "${env_file[@]}" "${network[@]}" \
      -v "$IMP_ROOT:/src" -v "$IMP_ROOT:$IMP_ROOT" -v "$data:/data" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      "${ports[@]}" \
      -e IMP_STORAGE_GIB="${IMP_STORAGE_GIB:-200}" \
      -e IMP_UPLINK_MTU="${IMP_UPLINK_MTU:-$(read_uplink_mtu)}" \
      -e IMP_KERNEL="$(in_container "$kernel")" \
      -e IMP_SYSTEM_DRIVE="$(in_container "$system")" \
      -e IMP_DEFAULT_IMAGE="${IMP_DEFAULT_IMAGE:-}" "${tuning[@]}" \
      -e IMP_BROKER_TEST_UPSTREAMS=/data/broker-test-upstreams.json \
      -e IMP_DASHBOARD_DIR=/src/packages/dashboard/dist \
      "$IMP_HOST_IMAGE" >/dev/null
    echo "dev.sh: started $name"
  fi
  wait_ready
  echo "dev.sh: impd ready on $api (token: scripts/dev.sh token)"
  echo "dev.sh: dashboard on $api/ui/ (bun run build:dashboard to build it)"
}

# down gives impd time to sleep every imp (SIGTERM), so memory survives
down() {
  if is_running; then
    docker stop -t 120 "$name" >/dev/null
    docker logs --tail 5 "$name" 2>&1 | grep 'every imp asleep' || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}

case ${1:-} in
  up) up ;;
  down) down ;;
  reboot)
    down
    up
    ;;
  logs) docker logs -f "$name" ;;
  restart)
    # SIGHUP: impd exits without sleeping the VMs; the entrypoint restarts it.
    # Wait for the old pid to go, so /health answers from the new impd.
    old=$(docker exec "$name" pgrep -f 'bun .*/daemon/src/main.ts' || true)
    if [ -n "$old" ]; then
      mapfile -t pids <<<"$old"
      docker exec "$name" kill -HUP "${pids[@]}"
      deadline=$((SECONDS + 30))
      while docker exec "$name" kill -0 "${pids[@]}" 2>/dev/null; do
        [ $SECONDS -lt $deadline ] || { echo "dev.sh: impd ${pids[*]} did not exit" >&2; exit 1; }
        sleep 0.2
      done
    fi
    wait_ready 60
    ;;
  shell) docker exec -it "$name" bash ;;
  token) docker exec "$name" cat /var/lib/imp/token ;;
  *)
    echo "usage: $0 up|down|reboot|logs|restart|shell|token" >&2
    exit 2
    ;;
esac
