#!/bin/bash
# Run impd in one long-lived dev host container (imp-dev), with its Docker
# socket proxy beside it (imp-dev-docker-proxy), as the deploy runs them.
#
#   scripts/dev.sh up        build what is missing, start the container, wait for impd
#   scripts/dev.sh down      stop the container (impd sleeps every imp first, so
#                            memory survives) and its proxy, and remove them; data
#                            stays in .data/dev
#   scripts/dev.sh reboot    down, then up: imps come back asleep and wake on demand
#   scripts/dev.sh logs      follow the container log
#   scripts/dev.sh restart   restart impd (SIGHUP), and the proxy if it changed;
#                            running VMs survive and are re-adopted
#   scripts/dev.sh shell     open a shell in the container
#   scripts/dev.sh token     print the API token (for IMP_TOKEN)
#   scripts/dev.sh prune     remove the dev host images of worktrees that are
#                            gone, and the untagged images rebuilds leave
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
#      IMP_HOST_IMAGE (default imp-host:dev-<dir>-<hash>, one per checkout:
#      dev_image_tag in scripts/lib.sh) tags the host image; down keeps it.
#      IMP_HOST_IMAGE_READY=1 uses the host image as it is instead of building
#      it (CI builds and loads it first, with its own cache).
#      Tuning passed through to impd when set: IMP_IDLE_TIMEOUT_S,
#      IMP_IDLE_CPU_PERCENT, IMP_RAM_BUDGET_MIB, IMP_BOOT_RESERVE_PERCENT,
#      IMP_WAKE_RESERVE_MIB, IMP_SLEEP_MIN_GUEST_UPTIME_MS, IMP_DEFAULT_VCPUS,
#      IMP_DEFAULT_MEMORY_MIB, IMP_DEFAULT_DISK_GIB, IMP_DISK_RESERVE_GIB, IMP_TAILSCALE_HOSTNAME,
#      IMP_BUILD_CONTEXT_MAX_MIB, the IMP_BUILD_* builder settings, IMP_WATCHDOG_TIMEOUT_S, IMP_WATCHDOG_ACTION, IMP_SUBNET6,
#      IMP_BOOT_TEMPLATES, IMP_JAILER, IMP_KSM, IMP_KSM_HEADROOM_PERCENT.
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
proxy=$name-docker-proxy
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
  IMP_BUILD_ISOLATION IMP_BUILD_MEMORY_MIB IMP_BUILD_DISK_GIB IMP_BUILD_IMAGE_MAX_MIB
  IMP_BUILD_IMAGE_MAX_FILES IMP_BUILD_IMAGE
  IMP_WATCHDOG_TIMEOUT_S IMP_WATCHDOG_ACTION IMP_KSM
  IMP_KSM_HEADROOM_PERCENT
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
  [ "$(docker inspect -f '{{.State.Running}}' "${1:-$name}" 2>/dev/null || true)" = true ]
}

# start_proxy runs imp-docker-proxy, compiled from the repo with the image's
# own bun, as the release image compiles it (host/Dockerfile), with the
# deploy's privileges and command, and waits for its socket. It compiles on
# every call, and replaces a running proxy when its stamp changed: the
# binary, the privileges, its env and the image, by tag and by id. With
# "keep", as up passes while impd runs, it leaves a changed proxy alone and
# says so, because a replacement would cut off a build or an export in
# flight; restart then replaces it before impd comes back. The socket's
# directory and the proxy's token are volumes of their own, which take the
# image's directories, owned by the proxy's user (host/Dockerfile); the
# token outlives a replaced proxy, so containers it made stay its own.
start_proxy() {
  local mode=${1:-replace} privileges context=() stamp
  mkdir -p "$data"
  docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$IMP_ROOT:/src:ro" -v "$data:/out" -w /src "$IMP_HOST_IMAGE" \
    bun build --compile packages/daemon/src/docker-proxy/main.ts \
    --outfile /out/imp-docker-proxy.new >/dev/null
  mapfile -t privileges < <(read_proxy_privileges)
  # the settings the proxy reads too: under imp isolation it pulls only IMP_BUILD_IMAGE
  local var
  for var in IMP_BUILD_CONTEXT_MAX_MIB IMP_BUILD_ISOLATION IMP_BUILD_IMAGE; do
    [ -n "${!var:-}" ] && context+=(-e "$var=${!var}")
  done
  stamp=$({
    sha256sum <"$data/imp-docker-proxy.new"
    printf '%s\n' "${privileges[@]}" "${context[@]}" "$IMP_HOST_IMAGE"
    docker image inspect -f '{{.Id}}' "$IMP_HOST_IMAGE"
  } | sha256sum)

  if is_running "$proxy" && [ "$stamp" = "$(cat "$data/imp-docker-proxy.stamp" 2>/dev/null)" ]; then
    rm -f "$data/imp-docker-proxy.new"
    return
  fi
  if is_running "$proxy" && [ "$mode" = keep ]; then
    rm -f "$data/imp-docker-proxy.new"
    echo "dev.sh: $proxy changed; scripts/dev.sh restart replaces it" >&2
    return
  fi

  mv -f "$data/imp-docker-proxy.new" "$data/imp-docker-proxy"
  docker rm -f "$proxy" >/dev/null 2>&1 || true
  docker run -d --name "$proxy" "${privileges[@]}" \
    --group-add "$(stat -c %g /var/run/docker.sock)" \
    -e "IMP_HOST_IMAGE=$IMP_HOST_IMAGE" "${context[@]}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$name-docker:/run/imp-docker" -v "$name-docker-proxy:/var/lib/imp-docker-proxy" \
    -v "$data/imp-docker-proxy:/usr/local/bin/imp-docker-proxy:ro" \
    "$IMP_HOST_IMAGE" /usr/local/bin/imp-docker-proxy >/dev/null
  local deadline=$((SECONDS + 30))
  until docker exec "$proxy" test -S /run/imp-docker/docker.sock 2>/dev/null; do
    if ! is_running "$proxy" || [ $SECONDS -ge $deadline ]; then
      echo "dev.sh: $proxy has no socket; last log lines:" >&2
      docker logs --tail 20 "$proxy" >&2 || true
      return 1
    fi
    sleep 0.2
  done
  echo "$stamp" >"$data/imp-docker-proxy.stamp"
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
    build_host_image
  fi
  if [ -z "${IMP_SYSTEM_DRIVE:-}" ]; then
    "$IMP_ROOT/scripts/build-system-drive.sh" >/dev/null
  fi
  [ -f "$system" ] || { echo "dev.sh: no system drive at $system" >&2; exit 1; }

  if is_running; then
    start_proxy keep
  else
    start_proxy
  fi
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
    # The deploy's privileges, not --privileged. The dev instance keeps its
    # XFS in a loop file: loop-control, and every loop device (b 7:*), for
    # the node setup-storage.sh makes.
    local privileges
    mapfile -t privileges < <(read_host_privileges)
    docker run -d --name "$name" --hostname "$name" "${privileges[@]}" \
      --device /dev/loop-control --device-cgroup-rule 'b 7:* rmw' \
      --dns 1.1.1.1 --dns 8.8.8.8 "${env_file[@]}" "${network[@]}" \
      -v "$IMP_ROOT:/src" -v "$IMP_ROOT:$IMP_ROOT" -v "$data:/data" \
      -v "$name-docker:/run/imp-docker:ro" \
      -e DOCKER_HOST=unix:///run/imp-docker/docker.sock \
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
  docker rm -f "$name" "$proxy" >/dev/null 2>&1 || true
  docker volume rm "$name-docker" "$name-docker-proxy" >/dev/null 2>&1 || true
}

# prune removes the dev host images that build_host_image labelled on this
# machine, whose checkout directory is gone and that no container uses. It
# removes only the checkout's own tag (dev_image_tag), so an override tag or
# a second tag keeps the image. Then the untagged ones rebuilds leave. Images
# of live checkouts stay as build caches; only labelled images are touched,
# never another project's or another machine's.
prune() {
  local machine ref id labels dir from
  machine=$(read_machine_id)
  if [ -z "$machine" ]; then
    echo "dev.sh: prune needs a machine id in ${IMP_MACHINE_ID_FILE:-/etc/machine-id}" >&2
    exit 1
  fi
  docker image ls --filter label=imp.worktree --format '{{.Repository}}:{{.Tag}} {{.ID}}' |
    while read -r ref id; do
      [[ $ref == *'<none>'* ]] && continue
      if ! labels=$(docker image inspect \
        -f '{{index .Config.Labels "imp.worktree"}}{{"\t"}}{{index .Config.Labels "imp.machine"}}' "$id"); then
        echo "dev.sh: keeping $ref: docker image inspect failed"
        continue
      fi
      dir=${labels%%$'\t'*}
      from=${labels#*$'\t'}
      # an empty label names no checkout, so it cannot be gone; an image
      # without this machine's id belongs to another machine or to none
      if [ -z "$dir" ] || [ -d "$dir" ] || [ "$from" != "$machine" ]; then continue; fi
      if [ "$ref" != "$(dev_image_tag "$dir")" ]; then
        echo "dev.sh: keeping $ref: not the tag of $dir"
        continue
      fi
      if [ -n "$(docker ps -aq --filter "ancestor=$id")" ]; then
        echo "dev.sh: keeping $ref: a container uses it"
        continue
      fi
      if ! docker image rm "$ref" >/dev/null; then
        echo "dev.sh: keeping $ref: docker image rm failed"
        continue
      fi
      echo "dev.sh: removed $ref ($dir is gone)"
    done
  docker image prune -f --filter label=imp.worktree --filter "label=imp.machine=$machine"
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
    is_running || { echo "dev.sh: $name is not running; use scripts/dev.sh up" >&2; exit 1; }
    # the proxy first: a changed proxy is replaced before impd comes back
    start_proxy
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
  prune) prune ;;
  *)
    echo "usage: $0 up|down|reboot|logs|restart|shell|token|prune" >&2
    exit 2
    ;;
esac
