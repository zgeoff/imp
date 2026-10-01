#!/bin/bash
# Host-side NAT and isolation for imp taps (DESIGN.md 2.6). Idempotent.
# Runs inside the host container's own network namespace.
set -euo pipefail

# Debian's iptables defaults to the nf_tables backend. Fall back to legacy
# if this kernel cannot do nf_tables.
if ! iptables -t nat -S >/dev/null 2>&1; then
  update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null
  echo "setup-net: using iptables-legacy"
fi

sysctl -qw net.ipv4.ip_forward=1

out=$(ip route show default | awk '{print $5; exit}')
if [ -z "$out" ]; then
  echo "setup-net: no default route" >&2
  exit 1
fi

# rule TABLE CHAIN ARGS...: append unless an identical rule exists.
rule() {
  local table=$1 chain=$2
  shift 2
  iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -A "$chain" "$@"
}

rule nat POSTROUTING -s 10.66.0.0/16 -o "$out" -j MASQUERADE
# No imp-to-imp traffic.
rule filter FORWARD -i imp+ -o imp+ -j DROP
rule filter FORWARD -i imp+ -o "$out" -j ACCEPT
rule filter FORWARD -i "$out" -o imp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# Guests may not reach the host container, except replies to its own
# connections (impd's proxy dials into guests).
rule filter INPUT -i imp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
rule filter INPUT -i imp+ -j DROP

echo "setup-net: forwarding imp+ via $out"
