#!/bin/bash
# Tailscale proof: a throwaway host container joins the tailnet as tag:imp and
# serves HTTP on 7080 and 20000; a tailnet member device fetches both ports by
# tailnet IP and by MagicDNS name. Then the node logs out and the container goes.
#
#   scripts/smoke-tailscale.sh
#
# Needs TAILSCALE_AUTHKEY in <repo>/.env (never printed) and a member device:
# the local tailscale CLI (WSL or Linux, untagged) and/or Windows tailscale.exe
# and curl.exe through WSL interop. Each one present is checked.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

name=imp-ts-smoke-$$
ts_host=imp-smoke
win_ts="/mnt/c/Program Files/Tailscale/tailscale.exe"
ports=(7080 20000)

key=${TAILSCALE_AUTHKEY:-}
if [ -z "$key" ] && [ -f "$IMP_ROOT/.env" ]; then
  key=$(sed -n 's/^TAILSCALE_AUTHKEY=//p' "$IMP_ROOT/.env" | tail -1)
  key=${key#[\"\']}
  key=${key%[\"\']}
fi
if [ -z "$key" ]; then
  echo "smoke-tailscale: TAILSCALE_AUTHKEY not set and not in .env" >&2
  exit 1
fi

# Member devices that can run the check.
checkers=()
if command -v tailscale >/dev/null \
  && [ "$(tailscale status --json 2>/dev/null | jq -r '.BackendState')" = Running ] \
  && [ "$(tailscale status --json | jq -r '.Self.Tags // [] | length')" = 0 ]; then
  checkers+=(local)
fi
if [ -x "$win_ts" ] && command -v curl.exe >/dev/null \
  && "$win_ts" status >/dev/null 2>&1; then
  checkers+=(windows)
fi
if [ ${#checkers[@]} = 0 ]; then
  echo "smoke-tailscale: no tailnet member device found to check from" >&2
  exit 1
fi

# leftovers prints peers named imp-smoke* that a member device still sees.
leftovers() {
  if [[ " ${checkers[*]} " == *" local "* ]]; then
    tailscale status --json | jq -r --arg h "$ts_host" \
      '.Peer[]? | select(.HostName | startswith($h)) | "\(.HostName) \(.TailscaleIPs[0]) online=\(.Online)"'
  else
    "$win_ts" status --json | tr -d '\r' | jq -r --arg h "$ts_host" \
      '.Peer[]? | select(.HostName | startswith($h)) | "\(.HostName) \(.TailscaleIPs[0]) online=\(.Online)"'
  fi
}

cleanup() {
  local rc=$?
  if docker inspect "$name" >/dev/null 2>&1; then
    if [ $rc -ne 0 ]; then
      echo "== FAILED (exit $rc); tailscaled log tail:"
      docker exec "$name" tail -20 /var/lib/imp/tailscale/tailscaled.log 2>/dev/null || true
    fi
    docker exec "$name" /w/host/scripts/tailscale-down.sh || true
    docker rm -f "$name" >/dev/null
  fi
}
trap cleanup EXIT

stale=$(leftovers)
if [ -n "$stale" ]; then
  echo "== note: stale $ts_host nodes on the tailnet (new node may get a -N suffix):"
  echo "$stale"
fi

ensure_host_image
echo "== start $name"
docker run -d --name "$name" --privileged -v "$IMP_ROOT:/w:ro" \
  "$IMP_HOST_IMAGE" sleep infinity >/dev/null

echo "== tailscale up"
# -e NAME with no value copies it from this environment: the key is not in argv.
TAILSCALE_AUTHKEY=$key docker exec -e TAILSCALE_AUTHKEY -e IMP_TAILSCALE_HOSTNAME=$ts_host \
  "$name" /w/host/scripts/tailscale-up.sh
self=$(docker exec "$name" tailscale status --json | jq -c '.Self')
ip=$(jq -r '.TailscaleIPs[0]' <<<"$self")
fqdn=$(jq -r '.DNSName | rtrimstr(".")' <<<"$self")
short=${fqdn%%.*}

# The host container still needs public DNS with its own tailscaled up.
if docker exec "$name" getent hosts pkgs.tailscale.com >/dev/null; then
  echo "ok   DNS inside the container"
else
  echo "FAIL DNS inside the container"
  exit 1
fi

echo "== serve ${ports[*]}"
for p in "${ports[@]}"; do
  docker exec "$name" sh -c "mkdir -p /srv/$p && echo imp-smoke-$p >/srv/$p/index.html \
    && setsid python3 -m http.server $p --directory /srv/$p >/dev/null 2>&1 </dev/null &"
done
for _ in $(seq 50); do
  docker exec "$name" sh -c "curl -sf localhost:${ports[0]} && curl -sf localhost:${ports[1]}" \
    >/dev/null 2>&1 && break
  sleep 0.1
done

# fetch CHECKER URL: print the body from that member device.
fetch() {
  case $1 in
    local) curl -sS --max-time 10 "$2" ;;
    windows) curl.exe -sS --max-time 10 "$2" | tr -d '\r' ;;
  esac
}

fail=0
for c in "${checkers[@]}"; do
  for p in "${ports[@]}"; do
    for h in "$ip" "$fqdn" "$short"; do
      url=http://$h:$p/
      t0=$(date +%s%N)
      # Fresh peers can need a few seconds for the first path (DERP, then direct).
      body=
      for _ in $(seq 10); do
        body=$(fetch "$c" "$url" 2>/dev/null) && break
        sleep 1
      done
      ms=$((($(date +%s%N) - t0) / 1000000))
      if [ "$body" = "imp-smoke-$p" ]; then
        echo "ok   $c $url (${ms} ms)"
      else
        echo "FAIL $c $url"
        fail=1
      fi
    done
  done
done

echo "== tailscale down"
docker exec "$name" /w/host/scripts/tailscale-down.sh
docker rm -f "$name" >/dev/null

# The ephemeral node is deleted on logout; give the netmap a moment to update.
left=
for _ in $(seq 20); do
  left=$(leftovers | grep -F " $ip " || true)
  [ -z "$left" ] && break
  sleep 1
done
if [ -n "$left" ]; then
  echo "FAIL node still on the tailnet: $left"
  fail=1
else
  echo "ok   node $short ($ip) removed from the tailnet"
fi

if [ "$fail" = 0 ]; then
  echo "== PASS"
else
  echo "== FAIL"
  exit 1
fi
