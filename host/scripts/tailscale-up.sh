#!/bin/bash
# Join the tailnet as tag:imp (docs/guides/tailscale.md). Idempotent.
# Runs inside the host container. With saved node state it starts tailscaled
# from that state first, so a joined node stays on the tailnet without a key
# (deploy/bootstrap.sh blanks it). Only when the saved node does not reach
# Running (logged out, or deleted by the control plane after a long time
# offline: NeedsLogin) does it join again, with the key if there is one.
# With neither state nor key it does nothing.
#
# Env: TAILSCALE_AUTHKEY         auth key (never printed; passed to tailscale via a 0600 file)
#      IMP_TAILSCALE_AUTHKEY_FILE  a file that holds the key instead (the NixOS module
#                                mounts one); read by tailscale itself, never by this script
#      IMP_TAILSCALE_HOSTNAME    tailnet hostname (default imp)
#      IMP_TAILSCALE_STATE_DIR   node state (default /var/lib/imp/tailscale); "mem" keeps it in memory
#      IMP_DNS                   resolvers used if resolv.conf points into the tailnet,
#                                comma-separated as impd reads it (default "1.1.1.1,8.8.8.8")
set -euo pipefail

hostname=${IMP_TAILSCALE_HOSTNAME:-imp}
state_dir=${IMP_TAILSCALE_STATE_DIR:-/var/lib/imp/tailscale}
sock=/var/run/tailscale/tailscaled.sock

key_file=${IMP_TAILSCALE_AUTHKEY_FILE:-}
# A missing bind-mount source makes docker create an empty directory there.
if [ -n "$key_file" ] && ! { [ -f "$key_file" ] && [ -s "$key_file" ]; }; then
  echo "tailscale-up: IMP_TAILSCALE_AUTHKEY_FILE $key_file is missing or empty; ignoring it" >&2
  key_file=
fi
has_key=
[ -n "${TAILSCALE_AUTHKEY:-}" ] || [ -n "$key_file" ] && has_key=1
has_state=
[ "$state_dir" != mem ] && [ -s "$state_dir/tailscaled.state" ] && has_state=1
if [ -z "$has_key" ] && [ -z "$has_state" ]; then
  echo "tailscale-up: no auth key and no saved node state, skipping"
  exit 0
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
# On a user-defined network (imp-host's, with IPv6) resolv.conf names
# Docker's embedded DNS, 127.0.0.11, which forwards from the host's network
# namespace ("ExtServers: [host(...)]"), so our tailscaled never sees those
# lookups and nothing needs changing.
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

# join: log in with the key. The key goes through a file so it never shows
# in argv (ps, /proc).
join() {
  local auth=$key_file rc=0
  if [ -z "$auth" ]; then
    auth=$(mktemp)
    chmod 0600 "$auth"
    printf '%s' "$TAILSCALE_AUTHKEY" >"$auth"
  fi
  ts up --reset --auth-key="file:$auth" --hostname="$hostname" \
    --advertise-tags=tag:imp --accept-dns=false --timeout=60s || rc=$?
  [ -n "$key_file" ] || rm -f "$auth"
  if [ "$rc" != 0 ]; then
    echo "tailscale-up: tailscale up failed with the key. A single-use key that was used already, an" \
      "expired or revoked key, or no route to the control plane; give a new key to join" >&2
    return 1
  fi
}

# needs_login: the saved node cannot come back by itself.
needs_login() { case $1 in NeedsLogin | NeedsMachineAuth | Stopped) return 0 ;; *) return 1 ;; esac; }

# wait_later: the saved node is still coming up, as on a boot with no
# network yet. tailscaled keeps trying by itself; this only joins with the
# key if the node turns out to need a login. Every 5 s, for 30 min.
wait_later() {
  local state
  for _ in $(seq 360); do
    state=$(backend)
    if [ "$state" = Running ]; then
      echo "tailscale-up: the saved node is Running"
      return 0
    elif needs_login "$state"; then
      if [ -n "$has_key" ]; then
        echo "tailscale-up: the saved node is $state; joining again with the key"
        join
        return
      fi
      echo "tailscale-up: the saved node is $state; give an auth key to join again" >&2
      return 1
    fi
    sleep 5
  done
  echo "tailscale-up: the saved node is still ${state:-unknown} after 30 min; tailscaled keeps trying" >&2
}

want_up=1
if [ -n "$has_state" ]; then
  # Starting comes before Running when the saved state is good. A key is
  # never used over a good state: it would make a second node.
  for _ in $(seq 150); do
    state=$(backend)
    { [ "$state" = Running ] || needs_login "$state"; } && break
    sleep 0.1
  done
  state=$(backend)
  if [ "$state" = Running ]; then
    want_up=0
    # Without a key the saved node is used as it is, even under another
    # hostname; with one, a new hostname logs in again.
    if [ -n "$has_key" ] && [ "$(ts status --json | jq -r '.Self.HostName')" != "$hostname" ]; then
      want_up=1
    fi
  elif needs_login "$state"; then
    if [ -z "$has_key" ]; then
      echo "tailscale-up: the saved node state is $state, not Running; give an auth key to join again" >&2
      exit 1
    fi
    echo "tailscale-up: the saved node state is $state, not Running; joining again with the key"
  else
    # Starting with no way out yet (no network): the state counts as good.
    # Exit 0 with tailscaled's socket up, so the entrypoint sets
    # IMP_TAILSCALE_NODE and impd comes up as a tailnet node.
    echo "tailscale-up: the saved node is still ${state:-unknown} after 15 s; going on, and waiting for it in the background"
    wait_later </dev/null &
    exit 0
  fi
elif [ "$(backend)" = Running ] \
  && [ "$(ts status --json | jq -r '.Self.HostName')" = "$hostname" ]; then
  # a second run while tailscaled is up (state in memory)
  want_up=0
fi

if [ $want_up = 1 ]; then
  join || exit 1
fi

for _ in $(seq 100); do [ "$(backend)" = Running ] && break; sleep 0.1; done
if [ "$(backend)" != Running ]; then
  echo "tailscale-up: backend state $(backend), not Running" >&2
  exit 1
fi

ts status --json | jq -r '.Self | "tailscale-up: \(.TailscaleIPs[0]) \(.DNSName | rtrimstr("."))"'
