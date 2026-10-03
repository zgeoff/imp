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
# 1. Pulls the image: this script's own release, unless IMP_HOST_IMAGE (the
#    environment, then with --compose the compose .env, then the env file)
#    names another. When the host already runs it, step 3 still installs
#    the image lines and files, and restarts nothing. Refuses an image that the restarted units would not run
#    (drop-ins count), and an env file with IMP_HOST_IMAGE= empty. Refuses an
#    image older than the Docker socket proxy (imp.host-contract other
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
#    which stays. First, an env file line IMP_HOST_IMAGE=...:latest, as every
#    env file had before the units named their release, is the old
#    template's, not a pin: it becomes a comment, and the file before is kept
#    as .bak-<time>. With --compose, IMP_HOST_IMAGE goes to the .env next to
#    the compose file (a .bak-<time> too), so a later `docker compose up -d`
#    keeps the image. Installed units and files lose the release-please
#    marker lines.
# 4. Prints how many imps will boot cold and how many run outdated parts, then
#    lists the imps: a NOTE says which boot cold on their next wake, and why
#    (docs/guides/operations.md#upgrade).
#
# Needs docker, curl and jq on the host.
#
# Env: IMP_HOST_IMAGE (default: from IMP_HOST_ENV_FILE, else this script's
#      release) must be the image the unit or the compose file runs.
#      IMP_HOST_ENV_FILE defaults to /etc/imp/imp-host.env.
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
# The image of this script's release, as its units name it; release-please
# bumps it.
readonly release_image=ghcr.io/zgeoff/imp-host:0.26.2 # x-release-please-version
# The image line every env file had before the units named their release.
readonly legacy_image_line=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest

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

# The awk function trim(line): line without a trailing \r or the blanks
# around it, as an env file edited on another system may have them, and
# without one pair of matching quotes around its value, which systemd takes
# off too. Its caller passes -v q="'".
# shellcheck disable=SC2016 # an awk program
readonly trim_awk='
function trim(line, value, first) {
  sub(/\r$/, "", line)
  gsub(/^[ \t]+|[ \t]+$/, "", line)
  if (!match(line, /^[A-Za-z_][A-Za-z0-9_]*=/)) return line
  value = substr(line, RLENGTH + 1)
  first = substr(value, 1, 1)
  if (length(value) < 2 || (first != q && first != "\"") || substr(value, length(value)) != first) return line
  return substr(line, 1, RLENGTH) substr(value, 2, length(value) - 2)
}'

# trim_lines FILE: each line of FILE through trim
trim_lines() {
  awk -v q="'" "$trim_awk"' { print trim($0) }' "$1" 2>/dev/null || true
}

# strip_markers: stdin without the release-please marker lines, which only
# the repo's copies need; deploy/bootstrap.sh strips them too
strip_markers() { grep -vE '^# x-release-please-(start-[a-z]+|end)$' || true; }

# the env file's pin, or nothing: its last non-empty IMP_HOST_IMAGE line
# that is not the legacy one, which migrate_env_file turns into a comment
pinned_image() {
  local line
  line=$(trim_lines "$env_file" | grep -E '^IMP_HOST_IMAGE=.' | grep -vxF "$legacy_image_line" | tail -n 1 || true)
  echo "${line#IMP_HOST_IMAGE=}"
}

# the .env next to the compose file, which compose reads at every `up`
compose_env_file() {
  echo "$(dirname "$compose_file")/.env"
}

# A line that sets IMP_HOST_IMAGE in an env file compose reads
readonly compose_env_line='^[ \t]*(export[ \t]+)?IMP_HOST_IMAGE[ \t]*='

# the compose .env's IMP_HOST_IMAGE as compose reads it: interpolated, and
# without a trailing comment; empty when it sets none. docker compose config
# tells it, with the shell's IMP_HOST_IMAGE unset, as that one would win. An
# older compose has no --environment: read_env_value reads the file instead.
compose_env_image() {
  local env config
  env=$(compose_env_file)
  [ -f "$env" ] || return 0
  # compose.yaml needs IMP_DOCKER_GID, as in restart_host
  if config=$(env -u IMP_HOST_IMAGE \
    IMP_DOCKER_GID="${IMP_DOCKER_GID:-$(stat -c %g /var/run/docker.sock 2>/dev/null || true)}" \
    docker compose -f "$compose_file" config --environment 2>/dev/null); then
    sed -n 's/^IMP_HOST_IMAGE=//p' <<<"$config" | tail -n 1
  else
    read_env_value "$env"
  fi
}

# read_env_value FILE: FILE's last IMP_HOST_IMAGE value as compose reads it:
# without its quotes, and an unquoted one ends at a blank before #. Fails,
# and says why, on a $ outside single quotes, which only compose resolves.
read_env_value() {
  local value
  # shellcheck disable=SC2016 # an awk program
  value=$(awk -v pattern="$compose_env_line" -v q="'" '
    { sub(/\r$/, "") }
    $0 ~ pattern { line = $0; found = 1 }
    END {
      if (!found) exit
      sub(/^[^=]*=[ \t]*/, "", line)
      first = substr(line, 1, 1)
      if (first == q || first == "\"") {
        line = substr(line, 2)
        line = substr(line, 1, index(line, first) - 1)
      } else {
        sub(/([ \t]+#.*)?[ \t]*$/, "", line)
      }
      print (first == q ? "literal:" : "raw:") line
    }' "$1")
  case $value in
    literal:*) echo "${value#literal:}" ;;
    raw:*\$*)
      echo "upgrade: $1 sets IMP_HOST_IMAGE from other variables, which only a docker compose with config --environment resolves: update Compose, or write the image there in full; nothing changed" >&2
      return 1
      ;;
    *) echo "${value#raw:}" ;;
  esac
}

# check_env_image FILE: fails, and says why, when FILE's last IMP_HOST_IMAGE
# is empty: systemd passes it over the units' own image, and docker run gets
# none. deploy/bootstrap.sh has the same check.
check_env_image() {
  [ "$(trim_lines "$1" | grep '^IMP_HOST_IMAGE=' | tail -n 1)" = IMP_HOST_IMAGE= ] || return 0
  echo "upgrade: $1 sets IMP_HOST_IMAGE= empty, which systemd passes over the units' own image: delete the line, or set an image; nothing changed" >&2
  return 1
}

# the image to move to: the environment, then (with --compose) the compose
# .env's, in $compose_image, then the env file's pin, then this script's
# release
read_image() {
  if [ -n "${IMP_HOST_IMAGE:-}" ]; then
    echo "$IMP_HOST_IMAGE"
    return
  fi
  { echo "$compose_image"; pinned_image; } | grep . | head -n 1 || echo "$release_image"
}

# the IMP_HOST_IMAGE that the Environment= lines of FILE... set, the last
# one winning. A line may set several, each one in double quotes or not.
environment_image() {
  sed -n 's/^Environment=//p' "$@" 2>/dev/null | xargs -n 1 2>/dev/null \
    | sed -n 's/^IMP_HOST_IMAGE=//p' | tail -n 1 || true
}

# unit_image UNIT INSTALLED: the image a unit runs after the restart: the env
# file's pin, else the default that UNIT (the new one when the image gives
# it) or a drop-in of INSTALLED sets; empty when none sets one
unit_image() {
  local pin
  pin=$(pinned_image)
  if [ -n "$pin" ]; then
    echo "$pin"
    return
  fi
  environment_image "$1" "$2".d/*.conf
}

# rewrite_file PATH AWK_PROGRAM [AWK_ARGS...]: PATH through awk, by rename,
# with the old PATH kept as PATH.bak-<time>, named in $backup. The env file
# holds secrets: the backup is 0600, and the new PATH keeps PATH's mode.
# Exits on a failure, before anything restarts.
rewrite_file() {
  local path=$1
  shift
  backup=$path.bak-$(date +%Y%m%d-%H%M%S)
  if ! { (umask 077 && cp "$path" "$backup") && chmod 600 "$backup" && cp -p "$path" "$path.new" \
    && awk "$@" "$backup" >"$path.new" && mv "$path.new" "$path"; }; then
    rm -f "$path.new"
    echo "upgrade: cannot rewrite $path; nothing restarted, the host still runs $old" >&2
    exit 1
  fi
}

# The legacy line becomes the commented pin, as in the env template: the
# units then run their release's image. Any other value is a pin and stays.
migrate_env_file() {
  trim_lines "$env_file" | grep -qxF "$legacy_image_line" || return 0
  # shellcheck disable=SC2016 # an awk program
  rewrite_file "$env_file" -v q="'" -v legacy="$legacy_image_line" -v pin="# IMP_HOST_IMAGE=$release_image" "$trim_awk"'
    trim($0) == legacy { print pin; next }
    { print }'
  echo "upgrade: $env_file: $legacy_image_line was the old template's line, not a pin; it is a comment now, and the units run their release's image (the file before: $backup)"
}

# IMP_HOST_IMAGE=$image in the compose .env: without it, a later `up -d`
# runs the compose file's default
write_compose_env() {
  local env
  env=$(compose_env_file)
  if [ ! -f "$env" ]; then
    echo "IMP_HOST_IMAGE=$image" >"$env"
    echo "upgrade: wrote IMP_HOST_IMAGE=$image to $env"
  elif [ "$compose_image" != "$image" ]; then
    # shellcheck disable=SC2016 # an awk program
    rewrite_file "$env" -v pattern="$compose_env_line" -v line="IMP_HOST_IMAGE=$image" \
      '$0 ~ pattern { if (!done) print line; done = 1; next } { print } END { if (!done) print line }'
    echo "upgrade: wrote IMP_HOST_IMAGE=$image to $env (the file before: $backup)"
  fi
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
  if ! docker run --rm "$image" cat "$image_deploy/$1" | strip_markers >"$2.new" || [ ! -s "$2.new" ]; then
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

# The env file's migration, then the files fetched into $new_files, and a
# daemon-reload when a unit changed. The migration comes first: a failed
# rewrite stops here, with the old units in place.
install_new_files() {
  local f unit_changed=
  migrate_env_file
  for f in "${new_files[@]}"; do
    if install_file "$f" && [ "$f" != "$seccomp_file" ]; then
      unit_changed=1
    fi
  done
  [ -z "$unit_changed" ] || systemctl daemon-reload
}

# the proxy first: imp-host starts after it, and impd's first docker call
# needs its socket
restart_host() {
  if [ -n "$compose_file" ]; then
    write_compose_env
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

# compose takes its image from the shell or its .env, never the env file
[ -n "$compose_file" ] || check_env_image "$env_file" || exit 1
compose_image=
[ -z "$compose_file" ] || compose_image=$(compose_env_image) || exit 1

image=$(read_image)

echo "upgrade: pulling $image"
docker pull -q "$image" >/dev/null

old=$(docker inspect -f '{{.Image}}' "$container")
new=$(docker image inspect -f '{{.Id}}' "$image")

[ "$old" = "$new" ] || echo "upgrade: $old -> $new"

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

# The units take the image from the env file, else their own default: one
# from the environment alone would pull here, then restart into another.
if [ -z "$compose_file" ]; then
  units=("$unit_file")
  [ "$new_contract" != socket-proxy ] || units+=("$proxy_unit_file")
  for f in "${units[@]}"; do
    [ -f "$f.new" ] || [ -f "$f" ] || continue
    unit_runs=$(unit_image "$([ -f "$f.new" ] && echo "$f.new" || echo "$f")" "$f")
    if [ -n "$unit_runs" ] && [ "$unit_runs" != "$image" ]; then
      echo "upgrade: $(basename "$f") would run $unit_runs, not $image; pin IMP_HOST_IMAGE=$image in $env_file and run again. Nothing changed." >&2
      exit 1
    fi
  done
fi

# A host on :latest may run this release's image already. It still gets
# its image lines and this image's units, or the old units' :latest would
# run another image at the next restart. Nothing restarts.
if [ "$old" = "$new" ]; then
  install_new_files
  [ -z "$compose_file" ] || write_compose_env
  echo "upgrade: $container already runs $new"
  exit 0
fi

# its own line: a failed `imp ls` stops the script before anything restarts
awake=$(list_awake)

for name in $awake; do
  if ! imp sleep "$name" >/dev/null; then
    echo "upgrade: $name did not sleep; the host still runs $old" >&2
    exit 1
  fi
  echo "upgrade: $name asleep"
done

install_new_files
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
