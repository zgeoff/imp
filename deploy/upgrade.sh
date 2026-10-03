#!/bin/bash
# Upgrade the imp host to a new release image without losing imps.
#
#   deploy/upgrade.sh                      the systemd unit (deploy/imp-host.service)
#   deploy/upgrade.sh --compose <file>     docker compose (deploy/compose.yaml)
#
# A host on an older release gets this script from the new image, not from
# its own release (docs/guides/operations.md#upgrade):
#
#   docker run --rm <new image> cat /usr/local/share/imp/deploy/upgrade.sh >upgrade.sh
#
# 1. Pulls the image. Nothing happens when the host already runs it. Refuses
#    an image older than the Docker socket proxy (imp.host-contract other
#    than socket-proxy) once the unit or compose file gives imp-host the
#    proxy's socket, and an image with no label once it runs without
#    --privileged: only deploy/bootstrap.sh of that image's release puts its
#    deploy back. Reads the image's seccomp profile and both units; one it
#    cannot read, or reads empty, stops the upgrade here.
# 2. Sleeps every awake imp through the API, one at a time, and stops on the
#    first that fails: the host keeps running the old image, untouched.
#    Stopping the container would sleep them too, but within its 120 s.
# 3. Installs the image's seccomp profile and systemd units by rename (with
#    --compose, the compose file is the operator's and stays), restarts
#    imp-docker-proxy, then the host, on the new image and waits for impd.
#    Local changes to a unit belong in a drop-in (imp-host.service.d/),
#    which stays.
# 4. Prints how many imps will boot cold and how many run outdated parts, then
#    lists the imps: a NOTE says which boot cold on their next wake, and why
#    (docs/guides/operations.md#upgrade).
#
# Needs docker, curl and jq on the host.
#
# Env: IMP_HOST_IMAGE (default: from IMP_HOST_ENV_FILE, else
#      ghcr.io/zgeoff/imp-host:latest) must be the image the unit or the
#      compose file runs. IMP_HOST_ENV_FILE defaults to /etc/imp/imp-host.env.
#      IMP_HOST_UNIT_FILE defaults to /etc/systemd/system/imp-host.service,
#      IMP_DOCKER_PROXY_UNIT_FILE to /etc/systemd/system/imp-docker-proxy.service,
#      IMP_HOST_SECCOMP_FILE to /etc/imp/imp-host.seccomp.json. With
#      --compose, IMP_DOCKER_GID defaults to the group of /var/run/docker.sock.
set -euo pipefail

container=imp-host
env_file=${IMP_HOST_ENV_FILE:-/etc/imp/imp-host.env}
unit_file=${IMP_HOST_UNIT_FILE:-/etc/systemd/system/imp-host.service}
proxy_unit_file=${IMP_DOCKER_PROXY_UNIT_FILE:-/etc/systemd/system/imp-docker-proxy.service}
seccomp_file=${IMP_HOST_SECCOMP_FILE:-/etc/imp/imp-host.seccomp.json}
image_deploy=/usr/local/share/imp/deploy
health=http://127.0.0.1:7070/health
compose_file=

usage() {
  echo "usage: $0 [--compose <file>]" >&2
  exit 2
}

case ${1:-} in
  '') ;;
  --compose)
    [ $# -eq 2 ] || usage
    compose_file=$2
    ;;
  *) usage ;;
esac

# the image the deploy files run: the environment, then the env file
read_image() {
  if [ -n "${IMP_HOST_IMAGE:-}" ]; then
    echo "$IMP_HOST_IMAGE"
    return
  fi
  local line
  line=$(grep -E '^IMP_HOST_IMAGE=.' "$env_file" 2>/dev/null | tail -n 1 || true)
  echo "${line#IMP_HOST_IMAGE=}" | grep . || echo ghcr.io/zgeoff/imp-host:latest
}

imp() {
  docker exec "$container" imp "$@"
}

list_awake() {
  local imps
  imps=$(imp ls --json) || return 1
  jq -r '.[] | select(.state == "running") | .name' <<<"$imps"
}

# the counts `imp info` reports; an older impd has none, and the NOTE column
# that follows still names each imp
print_boot_status() {
  local info
  if ! info=$(imp info --json); then
    echo "upgrade: imp info failed; see the NOTE column below" >&2
    return
  fi
  jq -r '
    if .bootStatus == null then
      "upgrade: this impd does not count cold boots; see the NOTE column below"
    else
      .bootStatus as $status
      | [$status.outdated | to_entries[] | select(.value > 0) | "\(.value) \(.key)"]
      | (if length == 0 then "none" else join(", ") end) as $outdated
      | "upgrade: \($status.coldBoots) imps will boot cold; outdated: \($outdated)"
    end' <<<"$info" || echo "upgrade: could not read imp info; see the NOTE column below" >&2
}

# IMAGE's imp.host-contract label (host/Dockerfile): socket-proxy runs
# without --privileged and reaches Docker through imp-docker-proxy;
# unprivileged, the release before, binds the host's docker.sock
contract_of() {
  docker image inspect -f '{{index .Config.Labels "imp.host-contract"}}' "$1"
}

# succeeds when FILE gives imp-host the proxy's socket, not the host's
proxy_deploy() {
  grep -q 'unix:///run/imp-docker/docker.sock' "$1"
}

# the deploy file in use: the unit, or the compose file
deploy_file() {
  echo "${compose_file:-$unit_file}"
}

# fetch_file NAME PATH: the image's deploy/NAME into PATH.new. Fails, and
# leaves no PATH.new, when the image cannot give it or gives it empty. Its
# caller tests it, so set -e is off in here: each step is checked.
fetch_file() {
  if ! docker run --rm "$image" cat "$image_deploy/$1" >"$2.new" || [ ! -s "$2.new" ]; then
    rm -f "$2.new"
    echo "upgrade: cannot read $image_deploy/$1 from $image; nothing changed, the host still runs $old" >&2
    return 1
  fi
}

# install_file PATH: PATH.new into place, by rename, when it differs; fails
# when it is unchanged
install_file() {
  if cmp -s "$1.new" "$1"; then
    rm -f "$1.new"
    return 1
  fi
  # its caller tests it, so set -e is off in here: a failed rename stops
  # the upgrade before the restart
  if ! mv "$1.new" "$1"; then
    echo "upgrade: cannot install $1; nothing restarted, the host still runs $old" >&2
    exit 1
  fi
  echo "upgrade: installed $1 from $image"
}

# the proxy first: imp-host starts after it, and impd's first docker call
# needs its socket
restart_host() {
  if [ -n "$compose_file" ]; then
    local services=(imp-host)
    ! grep -q '^  imp-docker-proxy:' "$compose_file" || services=(imp-docker-proxy imp-host)
    IMP_DOCKER_GID=${IMP_DOCKER_GID:-$(stat -c %g /var/run/docker.sock 2>/dev/null || true)} \
      IMP_HOST_IMAGE=$image docker compose -f "$compose_file" up -d "${services[@]}"
  elif [ "$new_contract" = socket-proxy ]; then
    systemctl enable -q imp-docker-proxy
    systemctl restart imp-docker-proxy
    systemctl restart imp-host
  else
    systemctl restart imp-host
  fi
}

wait_ready() {
  local deadline=$((SECONDS + 120))
  until curl -fsS "$health" 2>/dev/null | grep -q '"ready":true'; do
    if [ $SECONDS -ge $deadline ]; then
      echo "upgrade: impd is not ready after 120 s; see: docker logs $container" >&2
      exit 1
    fi
    sleep 1
  done
}

for tool in docker curl jq; do
  command -v "$tool" >/dev/null || { echo "upgrade: $tool is not installed" >&2; exit 1; }
done

if ! docker inspect "$container" >/dev/null 2>&1; then
  echo "upgrade: no $container container; start the host first (docs/guides/install.md)" >&2
  exit 1
fi

image=$(read_image)

echo "upgrade: pulling $image"
docker pull -q "$image" >/dev/null

old=$(docker inspect -f '{{.Image}}' "$container")
new=$(docker image inspect -f '{{.Id}}' "$image")

if [ "$old" = "$new" ]; then
  echo "upgrade: $container already runs $new"
  exit 0
fi

echo "upgrade: $old -> $new"

new_contract=$(contract_of "$image")
old_contract=$(contract_of "$old")

if [ "$new_contract" != socket-proxy ]; then
  if proxy_deploy "$(deploy_file)"; then
    echo "upgrade: $image predates the Docker socket proxy, and $(deploy_file) gives imp-host no docker.sock." >&2
    echo "upgrade: to roll back past it, run deploy/bootstrap.sh of that image's release (docs/guides/operations.md#upgrade)." >&2
    exit 1
  fi
  if [ -z "$new_contract" ] && ! grep -qE -- '--privileged|privileged: true' "$(deploy_file)"; then
    echo "upgrade: $image predates the unprivileged host, and $(deploy_file) runs without --privileged." >&2
    echo "upgrade: to roll back past it, run deploy/bootstrap.sh of that image's release (docs/guides/operations.md#upgrade)." >&2
    exit 1
  fi
fi

# The image's seccomp profile and units, read before any imp sleeps: an
# image that cannot give them stops the upgrade with the host untouched.
new_files=()
if [ -n "$new_contract" ]; then
  new_files=("$seccomp_file")
  [ -n "$compose_file" ] || new_files+=("$unit_file")
  [ -n "$compose_file" ] || [ "$new_contract" != socket-proxy ] || new_files+=("$proxy_unit_file")
fi
trap 'for f in "${new_files[@]}"; do rm -f "$f.new"; done' EXIT
for f in "${new_files[@]}"; do
  case $f in
    "$unit_file") deploy_name=imp-host.service ;;
    "$proxy_unit_file") deploy_name=imp-docker-proxy.service ;;
    *) deploy_name=imp-host.seccomp.json ;;
  esac
  fetch_file "$deploy_name" "$f" || exit 1
done

# its own line: a failed `imp ls` stops the script before anything restarts
awake=$(list_awake)

for name in $awake; do
  if ! imp sleep "$name" >/dev/null; then
    echo "upgrade: $name did not sleep; the host still runs $old" >&2
    exit 1
  fi
  echo "upgrade: $name asleep"
done

unit_changed=
for f in "${new_files[@]}"; do
  if install_file "$f" && [ "$f" != "$seccomp_file" ]; then
    unit_changed=1
  fi
done
[ -z "$unit_changed" ] || systemctl daemon-reload
restart_host
wait_ready

if [ "$old_contract" = "$new_contract" ]; then
  if [ -n "$compose_file" ] || [ "$new_contract" != socket-proxy ]; then
    echo "upgrade: done. To roll back: docker tag $old $image, then run the restart again."
  else
    echo "upgrade: done. To roll back: docker tag $old $image, then systemctl restart imp-docker-proxy imp-host."
  fi
else
  echo "upgrade: done. $old predates this host contract ($new_contract): to roll back to it, run deploy/bootstrap.sh of its release."
fi
if [ -n "$compose_file" ] && grep -q 'privileged: true' "$compose_file"; then
  echo "upgrade: NOTE: $compose_file still runs privileged; take the privileges of this release's deploy/compose.yaml" >&2
fi
if [ -n "$compose_file" ] && [ "$new_contract" = socket-proxy ] && ! proxy_deploy "$compose_file"; then
  echo "upgrade: NOTE: $compose_file still gives imp-host the host's docker.sock; take the imp-docker-proxy service and imp-host's volumes from this release's deploy/compose.yaml" >&2
fi
print_boot_status
imp ls
