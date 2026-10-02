#!/bin/bash
# Join the tailnet as tag:imp (docs/guides/tailscale.md). Idempotent.
# Runs inside the host container. Without TAILSCALE_AUTHKEY it starts
# tailscaled from saved node state, so a joined node stays on the tailnet
# after deploy/bootstrap.sh blanks the key; with neither it does nothing.
#
# Env: TAILSCALE_AUTHKEY         auth key (never printed; passed to tailscale via a 0600 file)
#      IMP_TAILSCALE_HOSTNAME    tailnet hostname (default imp)
#      IMP_TAILSCALE_STATE_DIR   node state (default /var/lib/imp/tailscale); "mem" keeps it in memory
#      IMP_DNS                   resolvers used if resolv.conf points into the tailnet,
#                                comma-separated as impd reads it (default "1.1.1.1,8.8.8.8")
set -euo pipefail

hostname=${IMP_TAILSCALE_HOSTNAME:-imp}
state_dir=${IMP_TAILSCALE_STATE_DIR:-/var/lib/imp/tailscale}
sock=/var/run/tailscale/tailscaled.sock

# from_state: no key, so the node can only come back from its saved state.
from_state=
if [ -z "${TAILSCALE_AUTHKEY:-}" ]; then
  if [ "$state_dir" = mem ] || [ ! -s "$state_dir/tailscaled.state" ]; then
    echo "tailscale-up: TAILSCALE_AUTHKEY unset and no saved node state, skipping"
    exit 0
  fi
  from_state=1
  echo "tailscale-up: TAILSCALE_AUTHKEY unset; starting from the saved node state"
fi

ts() { timeout 90 tailscale --socket="$sock" "$@"; }
# alive: tailscaled runs. A zombie does not count: PID 1 may not reap it.
# pgrep matches zombies too, so read the process state from ps instead.
# shellcheck disable=SC2009
alive() { ps -C tailscaled -o stat= | grep -qv '^Z'; }
backend() { timeout 5 tailscale --socket="$sock" status --json 2>/dev/null | jq -r '.BackendState // empty'; }

# Docker copies the host's resolv.conf. If the host runs Tailscale with
# MagicDNS, that is 100.100.100.100, which our own tailscaled captures; with
# --accept-dns=false it has no upstream, and all lookups (ACME too) fail.
if grep -qE '^nameserver[[:space:]]+(100\.100\.100\.100|fd7a:115c:a1e0::53)' /etc/resolv.conf; then
  dns=${IMP_DNS:-1.1.1.1,8.8.8.8}
  # Commas are the impd form; spaces still work.
  read -ra resolvers <<<"${dns//,/ }"
  printf 'nameserver %s\n' "${resolvers[@]}" >/etc/resolv.conf
  echo "tailscale-up: resolv.conf pointed into the tailnet; now ${resolvers[*]}"
fi

if ! alive; then
  mkdir -p /var/run/tailscale
  rm -f "$sock"
  if [ "$state_dir" = mem ]; then
    args=(--state=mem:)
    log=/var/log/tailscaled.log
  else
    mkdir -p "$state_dir"
    args=(--statedir="$state_dir")
    log=$state_dir/tailscaled.log
  fi
  # Kernel TUN mode: the container is privileged and has its own netns.
  setsid tailscaled "${args[@]}" --socket="$sock" --tun=tailscale0 \
    >"$log" 2>&1 </dev/null &
  for _ in $(seq 100); do [ -S "$sock" ] && break; sleep 0.1; done
  if [ ! -S "$sock" ]; then
    echo "tailscale-up: tailscaled did not start; log tail:" >&2
    tail -20 "$log" >&2
    exit 1
  fi
fi

# Wait for tailscaled to load its state before deciding whether to log in.
for _ in $(seq 50); do
  case $(backend) in NoState | "") sleep 0.1 ;; *) break ;; esac
done

if [ -n "$from_state" ]; then
  # Starting comes before Running when the saved state is good.
  for _ in $(seq 150); do
    case $(backend) in Running) break ;; *) sleep 0.1 ;; esac
  done
  if [ "$(backend)" != Running ]; then
    echo "tailscale-up: the saved node state is $(backend), not Running; set TAILSCALE_AUTHKEY to join again" >&2
    exit 1
  fi
fi

# Without a key there is nothing to log in with: the saved node is used as
# it is, even under another hostname.
want_up=1
if [ -n "$from_state" ]; then
  want_up=0
elif [ "$(backend)" = Running ] \
  && [ "$(ts status --json | jq -r '.Self.HostName')" = "$hostname" ]; then
  want_up=0
fi

if [ $want_up = 1 ]; then
  # The key goes through a file so it never shows in argv (ps, /proc).
  keyfile=$(mktemp)
  trap 'rm -f "$keyfile"' EXIT
  chmod 0600 "$keyfile"
  printf '%s' "$TAILSCALE_AUTHKEY" >"$keyfile"
  ts up --reset --auth-key="file:$keyfile" --hostname="$hostname" \
    --advertise-tags=tag:imp --accept-dns=false --timeout=60s
  rm -f "$keyfile"
fi

for _ in $(seq 100); do [ "$(backend)" = Running ] && break; sleep 0.1; done
if [ "$(backend)" != Running ]; then
  echo "tailscale-up: backend state $(backend), not Running" >&2
  exit 1
fi

ts status --json | jq -r '.Self | "tailscale-up: \(.TailscaleIPs[0]) \(.DNSName | rtrimstr("."))"'
