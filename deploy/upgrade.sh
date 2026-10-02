#!/bin/bash
# Upgrade the imp host to a new release image without losing imps.
#
#   deploy/upgrade.sh                      the systemd unit (deploy/imp-host.service)
#   deploy/upgrade.sh --compose <file>     docker compose (deploy/compose.yaml)
#
# 1. Pulls the image. Nothing happens when the host already runs it.
# 2. Sleeps every awake imp through the API, one at a time, and stops on the
#    first that fails: the host keeps running the old image, untouched.
#    Stopping the container would sleep them too, but within its 120 s.
# 3. Restarts the host on the new image and waits for impd.
# 4. Prints how many imps will boot cold and how many run outdated parts, then
#    lists the imps: a NOTE says which boot cold on their next wake, and why
#    (docs/guides/operations.md#upgrade).
#
# Needs docker, curl and jq on the host.
#
# Env: IMP_HOST_IMAGE (default: from IMP_HOST_ENV_FILE, else
#      ghcr.io/zgeoff/imp-host:latest) must be the image the unit or the
#      compose file runs. IMP_HOST_ENV_FILE defaults to /etc/imp/imp-host.env.
set -euo pipefail

container=imp-host
env_file=${IMP_HOST_ENV_FILE:-/etc/imp/imp-host.env}
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

restart_host() {
  if [ -n "$compose_file" ]; then
    IMP_HOST_IMAGE=$image docker compose -f "$compose_file" up -d imp-host
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

# its own line: a failed `imp ls` stops the script before anything restarts
awake=$(list_awake)

for name in $awake; do
  if ! imp sleep "$name" >/dev/null; then
    echo "upgrade: $name did not sleep; the host still runs $old" >&2
    exit 1
  fi
  echo "upgrade: $name asleep"
done

restart_host
wait_ready

echo "upgrade: done. To roll back: docker tag $old $image, then run the restart again."
print_boot_status
imp ls
