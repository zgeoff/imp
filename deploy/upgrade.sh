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
# 4. Lists the imps: a NOTE says which boot cold on their next wake, and why
#    (docs/guides/operations.md#upgrade).
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

# the imps impd lists as running, from the NAME and STATE columns
list_awake() {
  imp ls | awk 'NR > 1 && $2 == "running" { print $1 }'
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

for name in $(list_awake); do
  if ! imp sleep "$name" >/dev/null; then
    echo "upgrade: $name did not sleep; the host still runs $old" >&2
    exit 1
  fi
  echo "upgrade: $name asleep"
done

restart_host
wait_ready

echo "upgrade: done. To roll back: docker tag $old $image, then run the restart again."
imp ls
