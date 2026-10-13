# shellcheck shell=bash
# The functions that deploy/bootstrap.sh, deploy/upgrade.sh and the NixOS
# module (deploy/nixos/) share. upgrade.sh, deploy/nixos/imp-host-env.sh and
# deploy/nixos/config.nix source this file; scripts/render-imp-host.ts copies
# it into bootstrap.sh, which runs from a single download. The image ships it
# beside upgrade.sh, as /usr/local/share/imp/deploy/lib/host-env.sh.
#
# It sets constants and defines functions, and runs nothing.

# A computed RAM budget below this is refused: the host is too small for the
# formula, and the operator sets IMP_RAM_BUDGET_MIB.
readonly RAM_BUDGET_FLOOR_MIB=512
# With IPv6, imp-host runs on this Docker network. The bridge has a fixed
# name so a host firewall can admit it; the name keeps clear of imp's own
# interfaces (imp0, imp+). bun run render:deploy writes both, and
# host_addresses, from deploy/imp-host.args.json.
readonly HOST_NETWORK=imp-host
readonly HOST_BRIDGE=br-imphost
# docker network inspect: IPv6 on, the bridge's name, then every subnet.
# shellcheck disable=SC2034 # for its callers
readonly NETWORK_FORMAT='{{.EnableIPv6}} {{or (index .Options "com.docker.network.bridge.name") "unnamed"}}{{range .IPAM.Config}} {{.Subnet}}{{end}}'

# The awk function trim(line): line without a trailing \r or the blanks
# around it, as an env file edited on another system may have them, and
# without one pair of matching quotes around its value, which systemd takes
# off too. Its caller passes -v q="'".
# shellcheck disable=SC2016 # an awk program
readonly TRIM_AWK='
function trim(line, value, first) {
  sub(/\r$/, "", line)
  gsub(/^[ \t]+|[ \t]+$/, "", line)
  if (!match(line, /^[A-Za-z_][A-Za-z0-9_]*=/)) return line
  value = substr(line, RLENGTH + 1)
  first = substr(value, 1, 1)
  if (length(value) < 2 || (first != q && first != "\"") || substr(value, length(value)) != first) return line
  return substr(line, 1, RLENGTH) substr(value, 2, length(value) - 2)
}'

# trim_lines [FILE]: each line of FILE, else of stdin, through trim; nothing
# when FILE is missing
trim_lines() {
  awk -v q="'" "$TRIM_AWK"' { print trim($0) }' "$@" 2>/dev/null || true
}

# strip_markers: stdin without the release-please marker lines, which only
# the repo's copies need
strip_markers() { grep -vE '^# x-release-please-(start-[a-z]+|end)$' || true; }

# check_env_image FILE: fails, and says why, when FILE's last IMP_HOST_IMAGE
# is empty: systemd passes it over the units' own image, and docker run gets
# none.
check_env_image() {
  [ -f "$1" ] || return 0
  [ "$(trim_lines "$1" | grep '^IMP_HOST_IMAGE=' | tail -n 1)" = IMP_HOST_IMAGE= ] || return 0
  echo "$1 sets IMP_HOST_IMAGE= empty, which systemd passes over the units' own image: delete the line, or set an image" >&2
  return 1
}

# write_file PATH MODE CONTENT: PATH holds CONTENT and a newline, with MODE,
# written by rename. CONTENT may be secret: it goes through printf, a
# builtin, so not to argv.
write_file() {
  local path=$1 perm=$2 content=$3 tmp
  mkdir -p "$(dirname "$path")" || return 1
  tmp=$(mktemp "$path.XXXXXX") || return 1
  if ! { chmod "$perm" "$tmp" && printf '%s\n' "$content" >"$tmp" && mv "$tmp" "$path"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# ram_budget_mib MEMTOTAL_KIB [ARC_MIB]: the RAM awake imps may use. The
# host keeps the larger of 8 GiB and 15 % for itself, Docker, impd and the
# page cache, and with ZFS also the ARC's cap.
ram_budget_mib() {
  local total=$(($1 / 1024)) arc=${2:-0} reserve
  reserve=$((total * 15 / 100))
  [ "$reserve" -lt 8192 ] && reserve=8192
  echo $((total - reserve - arc))
}

# check_ram_budget BUDGET MEMTOTAL_KIB ARC_MIB SETTING: fail, saying why,
# when a computed budget is below the floor. SETTING names what the operator
# sets instead.
check_ram_budget() {
  local budget=$1 total=$(($2 / 1024)) arc=$3
  [ "$budget" -ge "$RAM_BUDGET_FLOOR_MIB" ] && return 0
  echo "the RAM budget for awake imps comes out at ${budget} MiB, below the ${RAM_BUDGET_FLOOR_MIB} MiB floor:" \
    "RAM ${total} MiB, less the larger of 8192 MiB and 15 %, less the ZFS ARC cap ${arc} MiB." \
    "Set $4 to what imps may use on this host" >&2
  return 1
}

# zfs_arc_max_mib MEMTOTAL_KIB: the cap on the ZFS ARC, 10 % of RAM within
# 1 to 8 GiB. Uncapped, the ARC grows to half of RAM, and the governor does
# not see what it takes from the guests.
zfs_arc_max_mib() {
  local arc=$(($1 / 1024 / 10))
  [ "$arc" -lt 1024 ] && arc=1024
  [ "$arc" -gt 8192 ] && arc=8192
  echo "$arc"
}

# ipv6_expand ADDR: the eight groups of an IPv6 address, colon-separated,
# lower case and without leading zeros; fails on anything else.
ipv6_expand() {
  local addr=${1,,} i
  local -a groups=() head=() tail=()
  if [[ $addr == *::* ]]; then
    [[ ${addr#*::} != *::* ]] || return 1
    [ -z "${addr%%::*}" ] || IFS=: read -ra head <<<"${addr%%::*}"
    [ -z "${addr#*::}" ] || IFS=: read -ra tail <<<"${addr#*::}"
    groups=("${head[@]}")
    for ((i = ${#head[@]} + ${#tail[@]}; i < 8; i++)); do groups+=(0); done
    groups+=("${tail[@]}")
  else
    IFS=: read -ra groups <<<"$addr"
  fi
  [ ${#groups[@]} = 8 ] || return 1
  for i in "${!groups[@]}"; do
    [[ ${groups[i]} =~ ^[0-9a-f]{1,4}$ ]] || return 1
    groups[i]=$(printf '%x' "0x${groups[i]}")
  done
  (
    IFS=:
    echo "${groups[*]}"
  )
}

# ipv6_canon ADDR[/LEN]: ADDR as Docker prints it (RFC 5952): lower case,
# no leading zeros, and the longest run of two or more zero groups as ::.
ipv6_canon() {
  local expanded suffix="" i
  [[ $1 == */* ]] && suffix=/${1#*/}
  expanded=$(ipv6_expand "${1%%/*}") || return 1
  local -a groups
  IFS=: read -ra groups <<<"$expanded"
  local best=-1 best_len=1 run=0 start=0
  for i in "${!groups[@]}"; do
    if [ "${groups[i]}" = 0 ]; then
      [ "$run" -gt 0 ] || start=$i
      run=$((run + 1))
      if [ "$run" -gt "$best_len" ]; then
        best=$start best_len=$run
      fi
    else
      run=0
    fi
  done
  if [ "$best" -lt 0 ]; then
    echo "$expanded$suffix"
    return
  fi
  local left right
  left=$(
    IFS=:
    echo "${groups[*]:0:best}"
  )
  right=$(
    IFS=:
    echo "${groups[*]:best+best_len}"
  )
  echo "$left::$right$suffix"
}

# subnet6 TEXT: TEXT as a canonical IPv6 /64 with no host bits; fails on
# anything else.
subnet6() {
  local expanded
  [[ $1 == */64 ]] || return 1
  expanded=$(ipv6_expand "${1%/64}") || return 1
  [[ $expanded == *:*:*:*:0:0:0:0 ]] || return 1
  ipv6_canon "$1"
}

# network_drift WANT INSPECT: how a network that docker network inspect
# (NETWORK_FORMAT) describes as INSPECT differs from IPv6 on the /64 WANT
# with the bridge HOST_BRIDGE; nothing when it matches.
network_drift() {
  local want=$1 enabled bridge subnet found="" have=()
  read -r enabled bridge subnet <<<"$2"
  if [ "$enabled" != true ]; then
    echo "it has no IPv6"
    return
  fi
  if [ "$bridge" != "$HOST_BRIDGE" ]; then
    echo "its bridge is $bridge, not $HOST_BRIDGE"
    return
  fi
  for subnet in $subnet; do
    [[ $subnet == *:* ]] || continue
    have+=("$subnet")
    [ "$(ipv6_canon "$subnet")" != "$want" ] || found=1
  done
  [ -n "$found" ] || echo "its IPv6 subnet is ${have[*]:-none}, not $want"
}

# host_addresses: the host's own global addresses, both families, with their
# prefixes, comma-separated; impd keeps public imps from them
# (docs/architecture/network/egress.md#public)
host_addresses() { ip -o addr show scope global | tr -s " " | cut -d " " -f 4 | paste -sd ,; }

# network_others: the containers on the network other than imp-host.
network_others() {
  docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$HOST_NETWORK" 2>/dev/null \
    | tr ' ' '\n' | grep -vx -e imp-host -e '' | paste -sd ' ' - || true
}

# create_host_network SUBNET6: the network imp-host runs on with IPv6, on
# the /64 SUBNET6, as the unit's ExecStartPre (deploy/imp-host.service) and
# the networks block of deploy/compose.yaml make it.
create_host_network() {
  docker network create --ipv6 --subnet "$1" \
    -o "com.docker.network.bridge.name=$HOST_BRIDGE" "$HOST_NETWORK" >/dev/null
}

# render_firewall PORT...: the nft ruleset. One transaction: create the
# table, delete it, create it again, so a reload replaces only our rules and
# never Docker's. Input only; Docker owns forwarding. The host itself is not
# a tailnet node (the host container is, and its traffic is forwarded), so no
# Tailscale port is open.
render_firewall() {
  local ports
  ports=$(printf '%s\n' "$@" | sort -nu | paste -sd, - | sed 's/,/, /g')
  cat <<EOF
# imp host firewall, written by deploy/bootstrap.sh. Loaded by
# imp-firewall.service. Inbound: SSH only.
table inet imp_host
delete table inet imp_host
table inet imp_host {
	chain input {
		type filter hook input priority filter; policy drop;
		iif "lo" accept
		ct state established,related accept
		ct state invalid drop
		meta l4proto icmp accept
		meta l4proto ipv6-icmp accept
		udp dport 68 accept comment "DHCPv4 client"
		udp dport 546 accept comment "DHCPv6 client"
		tcp dport { $ports } accept comment "SSH"
	}
}
EOF
}
