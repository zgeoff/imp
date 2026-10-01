#!/bin/bash
# Leave the tailnet: log out (an ephemeral node is deleted at once) and stop
# tailscaled. Idempotent. Runs inside the host container.
#
# A plain container stop does not log out: the node stays and keeps its name
# and IP when the container comes back with the same state dir.
set -euo pipefail

sock=/var/run/tailscale/tailscaled.sock

# alive: tailscaled runs. A zombie does not count: PID 1 may not reap it.
alive() { ps -C tailscaled -o stat= | grep -qv '^Z'; }

if alive; then
  timeout 30 tailscale --socket="$sock" logout 2>/dev/null || true
  pkill -x tailscaled || true
  for _ in $(seq 50); do alive || break; sleep 0.1; done
fi
echo "tailscale-down: logged out, tailscaled stopped"
