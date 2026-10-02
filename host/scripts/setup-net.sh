#!/bin/bash
# Host-side NAT and isolation for imp taps
# (docs/architecture/networking.md#iptables). Idempotent. Runs inside the host
# container's own network namespace.
set -euo pipefail

# Debian's iptables defaults to the nf_tables backend. Fall back to legacy
# if this kernel cannot do nf_tables.
if ! iptables -t nat -S >/dev/null 2>&1; then
  update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null
  update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null
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

# IMP_SUBNET is the pool impd carves guest /30s from; keep the default in
# step with packages/daemon/src/config.ts.
subnet=${IMP_SUBNET:-10.66.0.0/16}
rule nat POSTROUTING -s "$subnet" -o "$out" -j MASQUERADE
# No imp-to-imp traffic.
rule filter FORWARD -i imp+ -o imp+ -j DROP
rule filter FORWARD -i imp+ -o "$out" -j ACCEPT
rule filter FORWARD -i "$out" -o imp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# Guests may not reach the host container, except replies to its own
# connections (impd's proxy dials into guests).
rule filter INPUT -i imp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
rule filter INPUT -i imp+ -j DROP
# The taps get IPv6 link-local addresses, which the rules above do not cover.
# Guests get no IPv6 to the host at all.
if ip6tables -S INPUT >/dev/null 2>&1; then
  ip6tables -C INPUT -i imp+ -j DROP 2>/dev/null || ip6tables -A INPUT -i imp+ -j DROP
else
  echo "setup-net: no ip6tables; guest IPv6 to the host is not filtered" >&2
fi

# A guest may not send from another imp's address: the credential broker
# names the imp by it. A strict reverse-path check on the taps only, not a
# sysctl floor that would also bind eth0 and tailscale0.
rule raw PREROUTING -i imp+ -m rpfilter --invert -j DROP

# The credential broker (docs/guides/connectors.md): guests only. It listens
# on every address, so a packet for its port from anywhere else is dropped
# in raw PREROUTING, before tailscaled's ts-input chain (inserted first in
# INPUT later) can accept it. Both rules carry a comment, so a start with
# another IMP_BROKER_PORT removes the old ones. The ACCEPT goes first in
# INPUT: `rule` appends, which would put it under the DROP above. Keep the
# default in step with packages/daemon/src/config.ts.
broker_port=${IMP_BROKER_PORT:-7081}
broker_tag=(-m comment --comment imp-broker)
# The kept rule per chain: anything else tagged is stale, including the
# INPUT DROP an older setup-net.sh added.
for where in "filter INPUT ACCEPT" "raw PREROUTING DROP"; do
  read -r table chain target <<<"$where"
  stale=$(iptables -t "$table" -S "$chain" | grep -- '--comment imp-broker' \
    | grep -v -- "--dport $broker_port .*-j $target\$" || true)
  while read -r spec; do
    # shellcheck disable=SC2086 # the saved rule is split back into its words
    [ -z "$spec" ] || iptables -t "$table" ${spec/#-A/-D}
  done <<<"$stale"
done
iptables -C INPUT -i imp+ -p tcp --dport "$broker_port" "${broker_tag[@]}" -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -i imp+ -p tcp --dport "$broker_port" "${broker_tag[@]}" -j ACCEPT
rule raw PREROUTING ! -i imp+ -p tcp --dport "$broker_port" -m addrtype --dst-type LOCAL \
  "${broker_tag[@]}" -j DROP

# Tailnet identity (docs/guides/tokens.md) names a peer by its source
# address, so only tailscale0 may bring in Tailscale's ranges. tailscaled's
# own ts-input chain drops the rest in INPUT; this does it in raw, before
# any chain, for IPv4 and IPv6. Loopback stays: a connection to impd's own
# tailnet address comes in on lo.
rule raw PREROUTING -s 100.64.0.0/10 ! -i tailscale0 -m addrtype ! --src-type LOCAL -j DROP
if ip6tables -t raw -S PREROUTING >/dev/null 2>&1; then
  ip6tables -t raw -C PREROUTING -s fd7a:115c:a1e0::/48 ! -i tailscale0 -m addrtype ! --src-type LOCAL -j DROP 2>/dev/null \
    || ip6tables -t raw -A PREROUTING -s fd7a:115c:a1e0::/48 ! -i tailscale0 -m addrtype ! --src-type LOCAL -j DROP
fi

# The egress resolver (docs/architecture/networking.md, "Egress"): box and
# none guests reach it through impd's nat redirect of port 53, over UDP and
# TCP. The same pattern as the broker: an ACCEPT first in INPUT for the taps,
# and a raw drop of the port for anything else, both tagged, so a start with
# another IMP_EGRESS_DNS_PORT removes the old ones. Keep the default in step
# with packages/daemon/src/config.ts.
dns_port=${IMP_EGRESS_DNS_PORT:-7053}
dns_tag=(-m comment --comment imp-egress-dns)
for where in "filter INPUT ACCEPT" "raw PREROUTING DROP"; do
  read -r table chain target <<<"$where"
  stale=$(iptables -t "$table" -S "$chain" | grep -- '--comment imp-egress-dns' \
    | grep -v -- "--dport $dns_port .*-j $target\$" || true)
  while read -r spec; do
    # shellcheck disable=SC2086 # the saved rule is split back into its words
    [ -z "$spec" ] || iptables -t "$table" ${spec/#-A/-D}
  done <<<"$stale"
done
for proto in udp tcp; do
  iptables -C INPUT -i imp+ -p "$proto" --dport "$dns_port" "${dns_tag[@]}" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -i imp+ -p "$proto" --dport "$dns_port" "${dns_tag[@]}" -j ACCEPT
  rule raw PREROUTING ! -i imp+ -p "$proto" --dport "$dns_port" -m addrtype --dst-type LOCAL \
    "${dns_tag[@]}" -j DROP
done

# Clamp the TCP MSS of guest connections to the real uplink MTU. Behind a
# smaller-MTU uplink (WSL eth0 is 1360) frag-needed ICMP never reaches the
# guests, so large TLS records stall. IMP_UPLINK_MTU is the MTU outside this
# container; unset, fall back to the path MTU this namespace knows.
if [ -n "${IMP_UPLINK_MTU:-}" ]; then
  clamp=(--set-mss $((IMP_UPLINK_MTU - 40)))
else
  clamp=(--clamp-mss-to-pmtu)
fi
for dir in -i -o; do
  rule mangle FORWARD "$dir" imp+ -p tcp --tcp-flags SYN,RST SYN -j TCPMSS "${clamp[@]}"
done

echo "setup-net: forwarding imp+ ($subnet) via $out (mss: ${clamp[*]}, broker :$broker_port, dns :$dns_port)"
