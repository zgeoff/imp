# shellcheck shell=bash
# The firewall and ipv6 phases: the nft table that admits SSH only, and
# the Docker network imp-host runs on with IPv6.

ensure_firewall() {
  phase firewall
  if [ "$host_firewall" = none ]; then
    if systemctl -q is-enabled nftables 2>/dev/null && grep -qE '^[[:space:]]*flush ruleset' /etc/nftables.conf 2>/dev/null; then
      warn "nftables.service is enabled and /etc/nftables.conf flushes every ruleset, Docker's too, at each reload"
    fi
    remove_firewall
    return
  fi
  if systemctl -q is-enabled nftables 2>/dev/null; then
    die "nftables.service is enabled; its /etc/nftables.conf flushes every ruleset (Docker's too). Disable it first"
  fi
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    change "disable ufw (imp-firewall.service replaces it)" disable_ufw
  fi
  if systemctl -q is-active firewalld 2>/dev/null; then
    change "stop and disable firewalld (imp-firewall.service replaces it)" systemctl disable -q --now firewalld
  fi

  local ports
  mapfile -t ports < <(ssh_ports)
  [ ${#ports[@]} -gt 0 ] || die "found no SSH port; give --ssh-port"
  # sudo drops SSH_CONNECTION by default, and without it the check below
  # cannot see the session's port. sudo-rs (Ubuntu 26.04) ignores -E, so
  # name the variable.
  if [ -z "${SSH_CONNECTION:-}" ] && [ -n "${SUDO_USER:-}" ]; then
    die "run as root, or with sudo --preserve-env=SSH_CONNECTION, so the firewall phase can check this SSH session's port"
  fi
  local session_port
  session_port=$(awk '{ print $4 }' <<<"${SSH_CONNECTION:-}")
  if [ -n "$session_port" ] && ! printf '%s\n' "${ports[@]}" | grep -qx "$session_port"; then
    die "this SSH session uses port $session_port, which sshd does not report; give --ssh-port $session_port"
  fi
  log "SSH ports kept open: ${ports[*]}"
  if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
    warn "sshd allows password logins; set PasswordAuthentication no"
  fi

  local ruleset changed=
  ruleset=$(render_firewall "${ports[@]}")
  check_ruleset "$ruleset"
  put_file "$FIREWALL_FILE" 644 "$ruleset" && changed=1
  put_file /etc/systemd/system/imp-firewall.service 644 "$(unit_imp_firewall)" && changed=1
  if [ -n "$changed" ]; then
    change "load the firewall" reload_unit imp-firewall
  else
    ensure_service imp-firewall
  fi
}

# remove_firewall: with none, take out what an earlier run with own put in,
# but only when --host-firewall none asks for it; an env file that says none
# beside a loaded table is drift for the operator to settle. Only our table
# goes; the platform's rules stay.
remove_firewall() {
  local loaded=""
  if [ -e /etc/systemd/system/imp-firewall.service ] || [ -e "$FIREWALL_FILE" ] ||
    { command -v nft >/dev/null && nft list table inet imp_host >/dev/null 2>&1; }; then
    loaded=1
  fi
  if [ -z "$loaded" ]; then
    log "host firewall: none; imp adds no host rules"
    return
  fi
  if [ -z "$host_firewall_set" ]; then
    local msg="IMP_HOST_FIREWALL=none, but imp-firewall is still installed; run with --host-firewall none to remove it"
    dry || die "$msg"
    warn "$msg"
    changes=$((changes + 1))
    return
  fi
  change "remove imp-firewall.service and the inet imp_host table" uninstall_firewall
}

uninstall_firewall() {
  systemctl disable -q --now imp-firewall 2>/dev/null || true
  if command -v nft >/dev/null && nft list table inet imp_host >/dev/null 2>&1; then
    nft delete table inet imp_host || return 1
  fi
  rm -f /etc/systemd/system/imp-firewall.service "$FIREWALL_FILE"
  systemctl daemon-reload
  # An earlier run with own disabled ufw and firewalld.
  # Read first: under pipefail, grep -q quitting early fails nft with SIGPIPE.
  local rules
  rules=$(nft list ruleset 2>/dev/null || true)
  if ! grep -q 'hook input' <<<"$rules" &&
    ! { command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; } &&
    ! systemctl -q is-active firewalld 2>/dev/null; then
    warn "the host now has no inbound firewall; the platform must give one (docs/architecture/host.md#the-host-firewall)"
  fi
}

# check_ruleset RULESET: nft parses it against this kernel, so a bad ruleset
# never replaces a good one, or leaves the host with none. Skipped in a dry
# run before nftables is installed.
check_ruleset() {
  if ! command -v nft >/dev/null; then
    dry || die "nft is missing"
    return 0
  fi
  local file rc=0
  file=$(mktemp)
  printf '%s\n' "$1" >"$file"
  nft -c -f "$file" || rc=$?
  rm -f "$file"
  [ "$rc" = 0 ] || die "nft rejects the firewall ruleset; nothing was loaded"
}

disable_ufw() {
  ufw --force disable >/dev/null
  systemctl disable -q ufw
}

# ssh_ports: the union of the configured and the live SSH ports, plus
# --ssh-port. Ubuntu 24.04 starts sshd from ssh.socket, so sshd -T may not
# know the port the socket listens on.
ssh_ports() {
  {
    sshd -T 2>/dev/null | ssh_ports_from_sshd_t || true
    if systemctl -q is-active ssh.socket 2>/dev/null; then
      systemctl show -p Listen --value ssh.socket | ssh_ports_from_listen || true
    fi
    ss -Hltnp 2>/dev/null | awk '/"sshd/ { print $4 }' | ssh_ports_from_listen || true
    printf '%s\n' "${extra_ssh_ports[@]}"
  } | grep -E '^[0-9]+$' | sort -nu
}

# ssh_ports_from_sshd_t: ports from `sshd -T` output on stdin.
ssh_ports_from_sshd_t() { awk 'tolower($1) == "port" { print $2 }'; }

# ssh_ports_from_listen: ports from systemd socket Listen= values or `ss`
# local addresses on stdin, such as "[::]:22 (Stream)" or "0.0.0.0:2222".
ssh_ports_from_listen() { grep -oE ':[0-9]+( |$)' | tr -d ': '; }

unit_imp_firewall() {
  cat <<EOF
# Written by deploy/bootstrap.sh. Loads $FIREWALL_FILE before the network
# comes up, as Debian's nftables.service does.
[Unit]
Description=imp host firewall (inbound SSH only)
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $FIREWALL_FILE
ExecReload=/usr/sbin/nft -f $FIREWALL_FILE
ExecStop=/usr/sbin/nft delete table inet imp_host

[Install]
WantedBy=sysinit.target
EOF
}

# ensure_ipv6: with IPv6 on, imp-host's Docker network, and the host's
# router adverts kept once Docker turns on forwarding. Before the imp phase,
# so the unit's first start finds the network.
ensure_ipv6() {
  phase ipv6
  if [ "$ipv6" = off ]; then
    remove_ipv6
    return
  fi
  if ! check_docker_ipv6; then
    ipv6=off
    remove_ipv6
    return
  fi

  local inspect="" existing=""
  if command -v docker >/dev/null && inspect=$(docker network inspect -f "$NETWORK_FORMAT" "$HOST_NETWORK" 2>/dev/null); then
    existing=1
  fi
  resolve_subnet6 "$inspect"
  if ! ensure_router_adverts "$existing"; then
    ipv6=off
    remove_ipv6
    return
  fi

  settle_host_network "$existing" "$inspect"
}

# settle_host_network EXISTING INSPECT: create the network with
# $ipv6_subnet, or recreate one that differs, unless other containers use
# it. EXISTING: the network is there already, as INSPECT describes it.
settle_host_network() {
  local existing=$1 inspect=$2
  if [ -z "$existing" ]; then
    change "create the $HOST_NETWORK network: $ipv6_subnet on the bridge $HOST_BRIDGE" create_host_network "$ipv6_subnet"
    return
  fi
  local drift others
  drift=$(network_drift "$ipv6_subnet" "$inspect")
  if [ -z "$drift" ]; then
    log "network: $HOST_NETWORK, $ipv6_subnet on the bridge $HOST_BRIDGE"
    return
  fi
  others=$(network_others)
  [ -z "$others" ] || die "the $HOST_NETWORK network differs ($drift), and $others use it; move them off it, then run again"
  change "recreate the $HOST_NETWORK network ($drift): stop imp-host, then create it with $ipv6_subnet" recreate_host_network
}

# resolve_subnet6 INSPECT [ENV_FILE]: the env file's (default $ENV_FILE)
# IMP_HOST_SUBNET6, else the subnet of a network that is already right but
# for the env file, else a new random one.
resolve_subnet6() {
  local env_file=${2:-$ENV_FILE} env_value=""
  [ -f "$env_file" ] && env_value=$(sed -n 's/^IMP_HOST_SUBNET6=//p' "$env_file" | tail -n 1)
  if [ -n "$env_value" ]; then
    ipv6_subnet=$(subnet6 "$env_value") || die "$env_file says IMP_HOST_SUBNET6=$env_value; want an IPv6 /64"
    return
  fi
  ipv6_subnet=$(network_subnet6 "$1")
  [ -n "$ipv6_subnet" ] || ipv6_subnet=$(random_ula64)
}

# random_ula64: a random unique local /64 (RFC 4193): fd, a 40-bit global
# ID and subnet 0.
random_ula64() {
  local hex
  hex=$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')
  ipv6_canon "fd${hex:0:2}:${hex:2:4}:${hex:6:4}::/64"
}

# network_subnet6 INSPECT: the IPv6 subnet of a network with IPv6 and the
# bridge HOST_BRIDGE, or nothing.
network_subnet6() {
  local enabled bridge subnets subnet
  read -r enabled bridge subnets <<<"$1"
  [ "$enabled" = true ] && [ "$bridge" = "$HOST_BRIDGE" ] || return 0
  for subnet in $subnets; do
    if [[ $subnet == *:* ]]; then
      ipv6_canon "$subnet"
      return
    fi
  done
}

# check_docker_ipv6 [DAEMON_JSON]: Docker writes the NAT66 and forward rules
# for an IPv6 network itself from 27.0, where ip6tables became the default. A
# Docker without them refuses on, and turns auto off with a warning.
# DAEMON_JSON defaults to /etc/docker/daemon.json.
check_docker_ipv6() {
  # a dry run on a fresh host: the packages phase would install docker-ce
  command -v docker >/dev/null || return 0
  local daemon_json=${1:-/etc/docker/daemon.json} version why=""
  version=$(docker version -f '{{.Server.Version}}' 2>/dev/null) || die "cannot read the Docker daemon's version"
  if ! version_ge "$version" 27.0; then
    why="Docker $version predates 27.0, which writes IPv6 NAT and forward rules by default"
  elif [ -f "$daemon_json" ] && [ "$(jq -r '.ip6tables' "$daemon_json" 2>/dev/null)" = false ]; then
    why="$daemon_json sets ip6tables to false, so imp-host's network would have no NAT66"
  fi
  [ -n "$why" ] || return 0
  [ -n "$ipv6_auto" ] || die "$why; fix that, or give --ipv6 off"
  warn "$why; ipv6: off"
  return 1
}

# ensure_router_adverts EXISTING: Docker sets net.ipv6.conf.all.forwarding=1
# for an IPv6 network, and with forwarding on the kernel ignores router
# adverts where accept_ra=1: a host whose IPv6 default route comes from them
# loses it when it expires. accept_ra is per network namespace, so this
# applies in a test container too. EXISTING: the network is there already.
ensure_router_adverts() {
  local route uplink live file_uplink=""
  route=$(ip -6 route show default 2>/dev/null | head -n 1)
  uplink=$(route_uplink "$route")
  if [ -z "$uplink" ]; then
    log "router adverts: the host has no IPv6 default route"
    return
  fi
  [ -f "$RA_FILE" ] && file_uplink=$(ra_file_uplink <"$RA_FILE")
  live=$(cat "/proc/sys/net/ipv6/conf/$uplink/accept_ra")
  # Ours already (a second run finds 2), or the kernel's to take.
  if [ "$file_uplink" = "$uplink" ] || { route_is_ra "$route" && [ "$live" = 1 ]; }; then
    put_file "$RA_FILE" 644 "$(render_ra_file "$uplink")" || true
    if [ "$live" != 2 ]; then
      change "sysctl net/ipv6/conf/$uplink/accept_ra=2, so the kernel takes router adverts with forwarding on" \
        sysctl -qw "net/ipv6/conf/$uplink/accept_ra=2"
    fi
    return
  fi
  if ! route_is_ra "$route"; then
    log "router adverts: the IPv6 default route on $uplink does not come from them"
    return
  fi
  if [ "$live" = 2 ]; then
    log "router adverts: the kernel takes them on $uplink, with accept_ra=2"
    return
  fi
  ra_userspace "$uplink" "$1"
}

# route_uplink ROUTE: the device of an `ip -6 route` line, or nothing.
route_uplink() { awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }' <<<"$1"; }

# route_is_ra ROUTE: the route came from a router advert.
route_is_ra() { [[ " $1 " == *" proto ra "* ]]; }

# render_ra_file UPLINK: the sysctl.d file. The key's slash form keeps a
# dotted interface name (eth0.100) whole.
render_ra_file() {
  printf '%s\n' "# Written by deploy/bootstrap.sh (docs/guides/install.md#ipv6). Docker turns on" \
    "# IPv6 forwarding for imp-host's network; with forwarding on, the kernel" \
    "# takes router adverts on $1 only with accept_ra=2." \
    "net/ipv6/conf/$1/accept_ra = 2"
}

# ra_file_uplink: the uplink a RA_FILE on stdin names, or nothing.
ra_file_uplink() { sed -n 's|^net/ipv6/conf/\(.*\)/accept_ra = 2$|\1|p' | tail -n 1; }

# ra_userspace UPLINK EXISTING: accept_ra is 0, so a client takes the
# router adverts. Go on when its config keeps them with forwarding on, the
# operator says so (--ra-handled), or IPv6 was on already. Else auto turns
# IPv6 off with a warning (fails), and on stops.
ra_userspace() {
  local uplink=$1 owner network_file=""
  network_file=$(networkctl status "$uplink" 2>/dev/null | sed -n 's/^ *Network File: //p' || true)
  if [ -n "$network_file" ] && [ "$network_file" != n/a ]; then
    owner=systemd-networkd
    # networkd's IPv6AcceptRA defaults to off once forwarding is on; yes keeps it
    if cat "$network_file" "$network_file.d"/*.conf 2>/dev/null |
      grep -qiE '^[[:space:]]*IPv6AcceptRA[[:space:]]*=[[:space:]]*(yes|true|on|1)[[:space:]]*$'; then
      log "router adverts: systemd-networkd takes them on $uplink, with IPv6AcceptRA=yes in $network_file"
      return
    fi
  elif nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -qx "$uplink:connected"; then
    owner=NetworkManager
  elif pgrep -x dhcpcd >/dev/null; then
    owner=dhcpcd
  else
    owner="a client other than the kernel"
  fi
  if [ -n "$ra_handled" ]; then
    log "router adverts: $owner takes them on $uplink; --ra-handled says it keeps them with forwarding on"
    return
  fi
  if [ -n "$2" ]; then
    log "router adverts: $owner takes them on $uplink; IPv6 was on already"
    return
  fi
  local why="the IPv6 default route on $uplink comes from router adverts that $owner takes. Docker turns on IPv6 forwarding for imp-host's network, and $owner may then drop them, and the route with them. Make it keep router adverts with forwarding on (systemd-networkd: IPv6AcceptRA=yes; netplan: accept-ra: true), then run again with --ipv6 on --ra-handled (docs/guides/install.md#ipv6)"
  [ -n "$ipv6_auto" ] || die "$why; or give --ipv6 off"
  warn "$why. ipv6: off"
  return 1
}

# stop_imp_host: stop the unit, so imp-host leaves the network.
stop_imp_host() {
  systemctl stop imp-host 2>/dev/null || true
  docker rm -f imp-host >/dev/null 2>&1 || true
}

recreate_host_network() {
  stop_imp_host
  docker network rm "$HOST_NETWORK" >/dev/null && create_host_network "$ipv6_subnet"
}

# remove_ipv6 [RA_FILE]: with off, take out what an earlier run with on put in, but
# only when --ipv6 off asks for it, as with the firewall: an env file that
# says off beside the network is drift for the operator to settle.
# RA_FILE defaults to $RA_FILE.
remove_ipv6() {
  local ra_file=${1:-$RA_FILE} network="" file=""
  if command -v docker >/dev/null && docker network inspect "$HOST_NETWORK" >/dev/null 2>&1; then
    network=1
  fi
  [ ! -f "$ra_file" ] || file=1
  if [ -z "$network$file" ]; then
    log "ipv6: off; imp-host runs on Docker's default bridge"
    return
  fi
  if [ -z "$ipv6_set" ]; then
    local msg="IMP_HOST_IPV6=off, but the $HOST_NETWORK network or $ra_file is still there; run with --ipv6 off to remove them"
    dry || die "$msg"
    warn "$msg"
    changes=$((changes + 1))
    return
  fi
  if [ -n "$network" ]; then
    local others
    others=$(network_others)
    [ -z "$others" ] || die "$others use the $HOST_NETWORK network; move them off it, then run again"
    warn "turning IPv6 off cold-boots every imp that has an IPv6 prefix at its next start"
    change "stop imp-host and remove the $HOST_NETWORK network" remove_host_network
  fi
  # accept_ra stays 2 until a reboot, as forwarding stays on until then.
  [ -z "$file" ] || change "remove $ra_file (accept_ra keeps its value until a reboot)" rm -f "$ra_file"
}

remove_host_network() {
  stop_imp_host
  docker network rm "$HOST_NETWORK" >/dev/null
}
