# Networking

Every imp gets its own tap device and its own /30, routed through the host container, and an IPv6
/128 when the host has IPv6 ([IPv6](#ipv6)). No two imps share a layer-2 network, so they cannot see
each other, unless a [network](#networks) puts both on it. The wake proxy gives each imp an HTTP URL
on the host and on the tailnet, and an HTTPS URL on your own domain when one is set. The credential
broker listens on every imp's gateway.

## Addressing

- impd carves guest subnets out of `IMP_SUBNET` (default `10.66.0.0/16`). Slot `n` owns the /30 at
  offset `4n`: the host end is `4n+1`, the guest `4n+2`.
- The tap is `imp<slot>`. The guest MAC is `06:00` followed by the guest IP in hex, and a new tap's
  MAC is `06:01` followed by the host IP in hex. A woken guest's neighbour entry for its gateway
  then stays valid on a new tap: after a container restart, or on another host after a
  [warm move](./moves.md). A tap that exists keeps its MAC, which its guest knows.
- An imp keeps its slot for its whole life, so the tap name and the IP survive a sleep and a
  restore. A container restart removes the taps; a wake creates the tap again before it loads the
  snapshot.
- With IPv6, each imp also gets a /128 in the host's /64, and its gateway is `fe80::1`
  ([IPv6](#ipv6)).
- Guest DNS: `IMP_DNS` (default `1.1.1.1,8.8.8.8`), passed on the kernel command line. A `public`,
  `box` or `none` imp's queries go to impd's resolver whatever the guest asks ([Egress](#egress)).

## iptables

`host/scripts/setup-net.sh` sets the rules when the host container starts. They live in the
container's own network namespace and never touch the host's.

- `MASQUERADE` for the imp subnet out of the container's default route.
- `FORWARD -i imp+ -o imp+ DROP`: no imp-to-imp traffic. Above it,
  `FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -j ACCEPT` lets through what impd's
  table marked as traffic between two imps on one [network](#networks). It carries the comment
  `imp-network`; a start removes any other form of it.
- `INPUT -i imp+` drops everything except replies to connections the container opened (the proxy
  dials into guests), and the credential broker's port, `IMP_BROKER_PORT`. That rule is inserted
  first, above the drop.
- The broker listens on every address, so
  `raw PREROUTING ! -i imp+ -p tcp --dport $IMP_BROKER_PORT -m addrtype --dst-type LOCAL -j DROP`
  drops its port for anything but a guest. It sits in `raw`, before `INPUT`, where tailscaled later
  puts its `ts-input` chain first and would accept tailnet packets. Both broker rules carry the
  comment `imp-broker`; a start with another port removes the old ones.
- `raw PREROUTING -i imp+ -m rpfilter --invert -j DROP`: a strict reverse-path check on the taps
  only, so a guest cannot send with another imp's address. The broker names the imp by its address.
  A `rp_filter` sysctl would set the floor for `eth0` and `tailscale0` too, and break an exit node,
  subnet routes, or a container on more than one network.
- `raw PREROUTING -s 100.64.0.0/10 ! -i tailscale0 -m addrtype ! --src-type LOCAL -j DROP`, and the
  same for `fd7a:115c:a1e0::/48` with ip6tables: only `tailscale0` brings in Tailscale's ranges, so
  a [tailnet identity](../guides/tokens.md#tailnet-identity) names the real peer. A connection to
  the node's own address comes from a local address and stays.
- `ip6tables INPUT -i imp+` drops everything but router solicitations and neighbour solicitations
  and advertisements with a hop limit of 255. The taps have IPv6 addresses, and impd's API and proxy
  listen on IPv6 too; without this rule a guest reaches them over its tap. A guest's router
  advertisement or redirect is dropped here, and the taps ignore both anyway ([IPv6](#ipv6)). impd's
  nft table holds the same rule in an `input` chain, under every policy, so it holds where ip6tables
  is missing or `ip6tables -S INPUT` fails and setup-net.sh adds none. If impd cannot write its
  table, no `public`, `box` or `none` imp starts.
- `ip6tables FORWARD`: no imp-to-imp traffic; a tap may send out of the container's IPv6 default
  route; to a tap, only replies and related ICMPv6, such as packet-too-big. Anything else to or from
  a tap is dropped. The `raw` rpfilter rule is set for IPv6 as well.
- The egress resolver's port, `IMP_EGRESS_DNS_PORT` (default 7053), is accepted from the taps over
  UDP and TCP and dropped in `raw PREROUTING` from anywhere else, as the broker's is. The rules
  carry the comment `imp-egress-dns`.
- The TCP MSS of guest connections is clamped to the real uplink MTU (`IMP_UPLINK_MTU`): less 40 for
  IPv4, less 60 for IPv6. Behind a smaller-MTU uplink (WSL's is 1360), frag-needed ICMP never
  reaches the guests, and large TLS records stall.

## Egress

Each imp has an egress policy: what it may reach directly, past the host container.

| Policy   | The imp reaches                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `open`   | anything but `169.254.0.0/16` (metadata services), `100.64.0.0/10` (the tailnet), and the IPv6 ranges [IPv6](#ipv6) blocks |
| `public` | the global internet only ([Public](#public))                                                                               |
| `box`    | the addresses its allow-list's names resolve to, and the address ranges the list names                                     |
| `none`   | nothing                                                                                                                    |

Hosts a [grant](../guides/connectors.md) covers stay reachable under every policy, through the
credential broker: it dials them from the host container, which this firewall does not filter.
`open` is the default. `imp new --policy box --allow github.com,*.npmjs.org` sets one at create, and
`imp policy <name> box --allow …`, `open`, `public` or `none` changes it; `imp policy <name>` shows
it. An impd that knows `public` says so in `system.info` as `features.publicEgress`. An allow entry
is a hostname, `*.` and a hostname for every name under it (not the name itself), or an IPv4 or IPv6
address or CIDR (IPv6 from /16 to /128), the only way a box reaches a private address. A fork and a
backup restore carry the policy.

### The firewall

impd owns the nftables table `inet imp_egress` and writes it whole, in one `nft -f` transaction, at
start and on every create, destroy and policy change; DNS answers and expiries change only its sets.
Its `forward` chain runs before iptables' FORWARD and only drops and rejects, so setup-net's rules
still accept what it lets through.

- Traffic between two imps on one [network](#networks) is accepted and marked first. Any other
  packet from one tap to another is refused before a slot chain sees it, so no policy can accept it.
- A verdict map sends each tap (`imp<slot>`) to its slot's chain. A tap with no entry is refused.
- Each slot chain drops any source but the guest's own addresses, IPv4 and IPv6: rpfilter passes the
  other addresses of the guest's /30. An imp with no IPv6 address drops all IPv6.
- A `box` chain drops `ct state invalid`, lets established flows through, then accepts the list's
  ranges, refuses every range the broker refuses (`REFUSED_RANGES`) and `IMP_SUBNET`, and accepts
  the addresses in its set. Anything else is refused. IPv6 follows the same order: the list's
  ranges, then the blocked IPv6 ranges, then the addresses in its IPv6 set.
- A `public` chain drops `ct state invalid`, refuses a packet that would leave by any interface but
  a default route's of its family, then the addresses in its `public4` and `public6` sets, and
  accepts the rest ([Public](#public)).
- A refusal is a TCP reset, or ICMP admin-prohibited for anything else. A reset ends a live
  connection at once; ICMP alone leaves it retrying.
- impd writes a new imp's chain in the same step as its insert, before its tap comes up, and takes a
  destroyed imp's out before its slot is free. A box or none imp does not boot or wake where nft
  cannot run, nor does a public one; impd logs `impd: egress: NO FIREWALL` at start and refuses
  those policies.

### The resolver

A `public`, `box` or `none` imp's DNS goes to impd: a nat redirect sends its UDP and TCP port 53, to
any address outside `IMP_SUBNET`, to `IMP_EGRESS_DNS_PORT` on its gateway. impd knows the imp by the
source address. Only IPv4 is redirected (the `dns` chain matches `meta nfproto ipv4`): the guest's
resolv.conf names IPv4 servers, and port 53 over IPv6 meets the policy as any other port does. A
none imp sends no DNS over IPv6, and a box imp sends it only to an address its list allows. The
`ipv6` e2e suite checks both: a box imp's port 53 over IPv6 reaches an address its list allows, and
fails to any other. An `open` imp on a network has its IPv4 queries to `IMP_DNS` redirected too, for
its peers' names, and every name it asks is forwarded; it gets a higher rate limit.

- A name the policy does not allow gets REFUSED with Extended DNS Error 18 ("Prohibited") and never
  leaves the host. A query with more than one question is refused. Each imp has a rate limit; a
  query past it gets plain REFUSED, with no EDE, so the two can be told apart.
- Over TCP, each imp may hold 16 connections, and one idle for 10 s is closed.
- A `public` imp's names are all forwarded. impd removes every A and AAAA record in its `public4`
  and `public6` ranges from the reply, in every section, so a name that resolves only inside gets an
  empty answer. Nothing goes into a set, and the imp gets an open imp's rate limit.
- For an allowed name, impd asks `IMP_DNS`, under a fresh random query id, puts the A records on the
  CNAME chain from the name into the imp's set, and only then replies. The chain's names count as
  allowed for their TTL, for a stub resolver that follows the CNAME itself. AAAA does the same into
  the imp's IPv6 set when the host has IPv6 ([IPv6](#ipv6)); without it, AAAA gets an empty answer,
  so the guest uses IPv4.
- Each address expires at its TTL, clamped to between 5 minutes and a day, and a later answer
  extends it. impd keeps the expiry and a sweep every 30 s deletes what is due: nftables does not
  refresh an element's timeout on a second add before kernel 6.10.
- A reply's TTLs are at most 5 minutes, the shortest an address stays in the set, so a guest asks
  again before its address can expire.
- A set holds 4096 addresses; past that the soonest to expire goes.
- An impd restart starts the sets empty. impd resolves a box's exact names when the table is built,
  so a guest that cached them reaches them again at once.

A change of policy applies at once, whatever the imp's state: the table is keyed by slot. One that
nft does not take is undone, and the imp keeps its old policy. A box keeps the addresses some name
on its new list covers. When the new policy is not `open`, impd deletes the guest's conntrack
entries, so a flow the policy now denies ends on its next packet, and the broker closes the imp's
plain tunnels to hosts the new policy denies, and all of them on a change to `public`: they are
relays in impd, which conntrack never sees. A broker connection is tracked from the moment it is
accepted, so one whose CONNECT arrives after the change is held to the new policy.

Known limits:

- The firewall works on addresses. A CDN address that an allowed name resolved to stays allowed, for
  its clamped TTL plus up to 30 s, and with it every other name that address serves.
- So does DNS over HTTPS through an allowed address. DoT and DoH to public resolvers are refused by
  construction: their addresses are in no set unless the list names them.
- A guest that cached a wildcard name's address before an impd restart reaches it again only after
  it asks again: at most 5 minutes.

### Public

A `public` imp reaches the global internet only. The boundary: a `public` imp cannot open
connections to the host, impd, other imps (unless a network you create puts both on it), the
tailnet, link-local or private networks; the firewall does not and cannot restrict the guest's own
loopback.

Its slot chain checks, in order:

1. `ct state invalid` is dropped.
2. The interface: a packet that would leave by anything but a default route's interface of its own
   family (`ip route show default`, and `ip -6 route show default`) is refused. `tailscale0`, a
   Tailscale subnet route and a second Docker network are refused whatever address they carry. With
   no default route, everything is.
3. `public4`: every range the broker refuses (`REFUSED_RANGES`), `IMP_SUBNET`, the container's IPv4
   networks (each on-link route, and each address as its prefix and as a /32), the IPv4 entries of
   `IMP_EGRESS_DENY`, and each IPv4 network of `IMP_HOST_ADDRESSES`, prefix kept.
4. `public6`: the [blocked IPv6 ranges](#blocked-ranges), the imps' prefix, the container's IPv6
   prefixes, the documentation ranges `2001:db8::/32` and `3fff::/20`, the rest of `2001::/23`, the
   IPv6 entries of `IMP_EGRESS_DENY`, and each IPv6 network of `IMP_HOST_ADDRESSES`, prefix kept. An
   imp with no IPv6 address drops all IPv6.

imp-host runs in a network namespace of its own, so the Docker host's LAN is in none of the
container's prefixes: a global IPv6 /64, or a VPS's public IPv4 subnet, would be open to a public
imp. `IMP_HOST_ADDRESSES` keeps each address's prefix for that reason, and denies the whole network,
the host's neighbours on it included.

impd writes these sets only while some imp is public, and reads the container's routes for them at
each table build. A read that fails fails closed: impd logs
`impd: egress: reading the host container's routes: …`, writes no uplink, so a public chain refuses
everything, and refuses to start a public imp or set the policy until a later build reads them.
`REFUSED_RANGES` and the blocked IPv6 ranges hold every block that the IANA special-purpose
registries (2025-10-09) mark not globally reachable, and multicast; a unit test checks each block.
The anycast services in `2001::/23` that are globally reachable stay reachable.

The host container itself is never reached from a tap: `INPUT -i imp+` drops everything but the
broker's and the resolver's ports, and IPv6 gets neighbour discovery only, from setup-net.sh's
ip6tables and from impd's nft `input` chain, under every policy ([iptables](#iptables)). The public
chain covers what the container forwards: the Docker host behind the bridge gateway, the networks
past it, and the tailnet.

| Path                                                                | How it closes                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NAT64 and DNS64                                                     | `64:ff9b::/96` and `64:ff9b:1::/48` are refused, and the resolver removes a DNS64 answer in them.                                                                                                                                                                                      |
| 6to4 and Teredo                                                     | `2002::/16`, `2001::/32` and the old relay anycast `192.88.99.0/24` are refused.                                                                                                                                                                                                       |
| IPv4-mapped, IPv4-compatible and IPv4-translated IPv6               | `::ffff:0:0/96`, `::/96` and `::ffff:0:0:0/96` are refused. The broker dials a mapped answer as the IPv4 address it holds, under the IPv4 checks.                                                                                                                                      |
| A global address routed to a private service: a subnet route, a VPN | It leaves by another interface than the default route's.                                                                                                                                                                                                                               |
| A global address on the container's own network                     | `public4` and `public6` hold the container's networks.                                                                                                                                                                                                                                 |
| The Docker host's own addresses and the networks they are on        | `IMP_HOST_ADDRESSES` and `IMP_EGRESS_DENY`, which always holds `IMP_PUBLIC_IP` (see the limits below). A packet to them leaves by the uplink and reaches the host from the container's address, which a host firewall may trust.                                                       |
| DNS rebinding                                                       | Nothing opens: the firewall refuses by address, whatever a name resolved to. The resolver removes inside answers, so a guest tries the next address at once.                                                                                                                           |
| The credential broker                                               | It dials from the host container, which this firewall does not filter, as for every policy. A plain tunnel is refused every range above, every address of the host container, and an address that `ip route get` sends out by an interface other than a default route's of its family. |

Known limits:

- impd cannot see the Docker host's addresses from inside the container. `deploy/imp-host.service`
  (which `bootstrap.sh` installs) and the NixOS module read them at each start into
  `IMP_HOST_ADDRESSES`: every global-scope address with its prefix, IPv4 and IPv6
  (`ip -o addr show scope global`). `deploy/compose.yaml` does not; there, list the host's addresses
  and networks in `IMP_EGRESS_DENY`. While a public imp exists and `IMP_HOST_ADDRESSES` is empty,
  impd logs `impd: egress: WARNING: a public imp exists and IMP_HOST_ADDRESSES is empty`, whatever
  `IMP_EGRESS_DENY` holds.
- The public sets are only as complete as the host data they get. A host address given without its
  prefix (counted as a /32 or /128), or a network the host joins after the start, stays reachable
  until `IMP_HOST_ADDRESSES` or `IMP_EGRESS_DENY` covers it. This holds for the broker too: a public
  imp's plain tunnel is refused the same lists, and reaches what they miss.
- The addresses are read only when imp-host starts. An IPv6 privacy address that rotates inside the
  same /64 stays covered by the prefix, but an address on a new network (a new DHCP lease elsewhere,
  a new SLAAC prefix from the router) is reachable until `systemctl restart imp-host`. A timer would
  not help: the container's environment is fixed at its start.
- Routing on the Docker host is the operator's boundary. If the host itself routes, NATs or DNATs a
  global address to a private service (a VPN, a port forward, a load balancer's backend), the public
  chain and the broker see only the global address and allow it. Only `IMP_EGRESS_DENY` closes it.
- A host a [grant](../guides/connectors.md) covers is reached through the broker, whatever its
  address, as under every policy.
- The resolver forwards every name, so a name in a private zone of `IMP_DNS` gets an answer, with
  its inside addresses removed.
- When the default route moves to another interface, the table follows at its next build: a create,
  a destroy or a policy change. Until then, a public imp's traffic out of the new interface is
  refused.

## IPv6

`IMP_SUBNET6` sets what IPv6 imps get. impd decides once, at start, and logs it as `impd: ipv6: …`.
It fails closed: when setup-net's IPv6 rules and settings are not all in place (no ip6tables, say),
or the NAT66 table cannot be written, imps get no IPv6, and IPv4 and its firewall go on as before.

| `IMP_SUBNET6`    | Imps get                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | A unique local /64 (`fd`, then 40 random bits), kept in `<data>/net/ipv6-ula`, behind NAT66 out of the container's IPv6 default route. With no such route, no IPv6. That is common: see the limits below. |
| a /64            | That prefix, routed, with no NAT. The network must route the /64 to the host container.                                                                                                                   |
| `off`            | No IPv6.                                                                                                                                                                                                  |

- An imp's address is the prefix with its IPv4 address as the interface ID: `10.66.0.6` in
  `fd12:3456:789a::/64` is `fd12:3456:789a::a42:6`. It lasts as long as the slot and the prefix.
- Every tap has `fe80::1`, with no duplicate address detection, and impd routes the imp's /128 to
  the tap. The kernel command line carries `imp.ip6=<address>/128 imp.gw6=fe80::1`. The agent adds
  the address and a default route via `fe80::1`, and turns off router advertisements and redirects
  on `eth0`. An older agent ignores both parameters, and the imp has IPv4 only.
- NAT66 is impd's table `ip6 imp_nat66`: it masquerades the prefix out of the uplink. impd writes it
  at start under `auto` and deletes it under `off` or a routed /64.
- Packet-too-big from beyond the host reaches the guest as related traffic, so path MTU discovery
  works. The MSS clamp covers TCP behind a smaller-MTU uplink.

### Router advertisements

A guest on a tap could send router advertisements or redirects, and the host container, which
forwards, could take one as its route out. Nothing a guest sends changes the container's routes:

- `setup-net.sh` tries `accept_ra=2` on the uplink only, so it would keep a default route learned
  from adverts with forwarding on. Without `--privileged`, `/proc/sys` is read-only, so this always
  fails with a warning: a container route learned from adverts is not supported. Docker's networks,
  the default bridge and `imp-host`, give the container a static default route, which needs none.
  The defaults get `accept_ra=0` and `accept_redirects=0`, and impd sets both on each tap before it
  comes up. setup-net and impd write a key only when it differs, so values from
  `docker run --sysctl` and a read-only `/proc/sys` work.
- setup-net reads the uplink, the interface of the IPv6 default route, once at start, for
  `accept_ra=2` and the FORWARD accept out of it. If the default route moves to another interface
  later, imps' IPv6 stops until the container restarts.
- `ip6tables INPUT` accepts only router solicitations and neighbour solicitations and advertisements
  from the taps, with a hop limit of 255. Everything else is dropped.

### Blocked ranges

The `open` and `box` chains refuse these, and the credential broker never dials them:

| Range                              | Why                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fc00::/7`                         | Unique local: private networks, the imps' own `auto` prefix among them.                                                                                                  |
| `fe80::/10`                        | Link-local: the taps and the container's own links.                                                                                                                      |
| `ff00::/8`                         | Multicast.                                                                                                                                                               |
| `::/128`, `::1/128`                | Unspecified and loopback.                                                                                                                                                |
| `::ffff:0:0/96`                    | IPv4-mapped: an IPv4 address in IPv6 form would pass the IPv4 checks.                                                                                                    |
| `::/96`                            | IPv4-compatible, long deprecated: the same, without the `ffff`.                                                                                                          |
| `::ffff:0:0:0/96`                  | IPv4-translated (SIIT): a translator would reach the IPv4 address it holds.                                                                                              |
| `100::/64`                         | Discard-only: nothing legitimate is there.                                                                                                                               |
| `64:ff9b::/96`, `64:ff9b:1::/48`   | NAT64: a translator on the path would reach private IPv4 addresses.                                                                                                      |
| `2002::/16`                        | 6to4: the address holds an IPv4 address, which a relay reaches.                                                                                                          |
| `2001::/32`                        | Teredo: the same.                                                                                                                                                        |
| `100:0:0:1::/64`                   | The dummy prefix: never routed.                                                                                                                                          |
| `2001:2::/48`                      | Benchmarking.                                                                                                                                                            |
| `2001:10::/28`                     | The old ORCHID: retired.                                                                                                                                                 |
| `5f00::/16`                        | Segment routing IDs: never a host.                                                                                                                                       |
| the imps' prefix                   | Other imps.                                                                                                                                                              |
| the container's connected prefixes | The host's own networks, such as its Docker network: every on-link route, whatever made it, and the prefix of every global address. impd reads them at each table build. |

A `public` imp is refused the documentation ranges `2001:db8::/32` and `3fff::/20` too; `open` and
`box` imps are not, as test networks use them. It is refused the rest of `2001::/23` too, which the
registry marks not globally reachable: only AMT `2001:3::/32`, AS112 `2001:4:112::/48`, ORCHIDv2
`2001:20::/28` and DETs `2001:30::/28` stay open. The anycast PCP, TURN and SRP addresses in
`2001:1::/32` go with it, as the nearest of their servers can sit on the host's own network.

The broker reads the connected prefixes every 30 s. It dials an IPv4-mapped answer as its IPv4
address, under the IPv4 checks.

### A new prefix

A snapshot holds the prefix it was made under. When the host's prefix changes, or IPv6 goes off, the
imp boots cold on its next wake, with the reason `the IPv6 prefix changed (<old> → <new>)`. An imp
that booted with no IPv6 wakes as it was; while the host has a prefix, `imp info` and the dashboard
note `no IPv6 until its next cold boot` for it.

Known limits:

- `auto` means off on Docker's default bridge, which is IPv4 only. impd then logs
  `impd: ipv6: off (IMP_SUBNET6=auto, and the container has no IPv6 default route)`.
  `bootstrap.sh --ipv6` and the NixOS module's `ipv6.enable` put the container on a network with
  IPv6 ([IPv6](../guides/install.md#ipv6)).
- A routed /64 needs a route to it on the network:
  `ip -6 route add <prefix> via <container address>`. The container's address can change when it is
  made again.
- Behind NAT66, every imp shares the container's address to the outside.
- There is no SLAAC or DHCPv6, and one address per imp.

## Networks

A [network](../guides/networks.md) lets its imps reach one another. The rows are `networks` and
`network_members`; deleting an imp or a network deletes its memberships with it.

- Each network is a set `net<n>` of `ifname . ipv4_addr` pairs: each member's tap and address. The
  rule `iifname . ip saddr @net<n> oifname . ip daddr @net<n>` checks both ends, each against its
  own tap, so a guest that sends from another address matches nothing. A match sets the mark
  `0x01000000` with an OR, so a bit another program uses survives, and is accepted; iptables then
  accepts the mark ahead of its imp-to-imp DROP.
- The mark bit is `0x01000000`. Calico's default mark mask (`0xffff0000`) covers it, and other
  programs that mark packets may too. The rules live in the host container's own network namespace,
  so only a program that marks packets inside that namespace could clash.
- impd checks at start that setup-net's `imp-network` ACCEPT is in FORWARD, and logs
  `imp-network ACCEPT is missing` when it is not: then the imp-to-imp DROP takes every packet, and
  networks fail closed.
- A change whose table nft refuses puts its rows back; when that undo fails too, impd logs it and
  writes the table from the rows as they are, so a failed leave or `net rm` never leaves a pair
  connected that the rows part.
- The rules come before the egress policies, so a network reaches past `box` and `none`. Networks
  are IPv4 only. `oifname "imp*" goto deny` follows them: no other packet between taps passes, IPv6
  included.
- A join, a leave and a network's delete go through the same lock as a policy change, then the table
  is written whole. A table nft does not take puts the rows back. A pair of addresses that no longer
  shares a network has its conntrack entries deleted in both directions; the next packet of a held
  connection is refused with a reset in any case, since the rules do not look at `ct state`.
- A destroyed imp leaves the sets with its slot, before its row goes.
- impd answers `<imp>.<network>.internal` (for a network that exists), a peer's bare name, and every
  reverse name inside `IMP_SUBNET` itself, before the policy's verdict, so none is ever forwarded. A
  name of the zone the asker shares no network with is NXDOMAIN. The answers never go into a box's
  set: the peer rule, not the set, lets the traffic through.
- With no nft (`NO FIREWALL`), nothing marks a packet, and iptables drops all imp-to-imp traffic:
  networks fail closed.

## The wake proxy

The proxy forwards HTTP and WebSockets to an imp's HTTP port. The port is set at create
(`imp new --http-port`, default 8080) and changed with `imp set --http-port`, which holds from the
next request.

- **Host routing.** On `IMP_PROXY_PORT` (default 7080), the first label of the Host header names the
  imp: `<name>.imp.localhost:7080`, or any `<name>.<domain>`.
- **One port per imp.** On `IMP_PORT_BASE + slot` (default base 20000), every request goes to that
  imp. The tailnet uses these ports. impd refuses to start when `IMP_API_PORT` or `IMP_PROXY_PORT`
  falls in that range, or when the range runs past port 65535.
- A request wakes a sleeping imp or boots a stopped one, then goes through. A response that needed a
  wake carries an `x-imp-wake-ms` header.
- WebSockets are relayed message by message.
- The proxy sends `Connection: close` upstream. A finished request then leaves no keep-alive socket
  in the guest that would keep it awake.
- Errors are short HTML pages: 404 for an unknown imp, 503 when it could not wake, 502 when nothing
  answers on the port.
- **HTTPS on a domain.** With `IMP_DOMAIN`, TLS listeners on 443 hand requests to the same proxy,
  and 80 redirects to them. They bind the tailnet IP and loopback only, and accept exactly
  `<name>.<domain>` for an imp and `<domain>` for impd's API
  ([HTTPS](../guides/https.md#listeners)).

## The credential broker

Guests reach the broker on their gateway at `IMP_BROKER_PORT` (default 7081), through `HTTPS_PROXY`.
It takes `CONNECT` only. A granted host goes to a TLS terminator that adds the credential; any other
host gets a plain tunnel to a checked public address. A tunnel starts inside the host container,
past the `INPUT` drop, so it refuses every private, shared, loopback and link-local range, the
blocked IPv6 ranges ([IPv6](#ipv6)), and the container's own addresses. It dials IPv6 only when the
host gives imps IPv6, IPv4 answers first. The broker also drops a guest that dials another imp's
gateway. The [connectors guide](../guides/connectors.md) has the whole design.

## The SSH gateway

impd's SSH gateway listens on `IMP_SSH_PORT` (default 22) on IPv4, in the container's own network
namespace, like the API. The tailnet reaches it through `tailscale0`, the firewall above keeps the
guests off it, and only `scripts/dev.sh` publishes it, on `127.0.0.1:2222`. Forwards go through the
agent's `dial` from inside the guest, never from the host container to the guest's IP, so a forward
reaches programs that listen on the guest's loopback. A remote forward (`ssh -R`) listens in the
guest through the agent, on its `127.0.0.1` only. The [SSH guide](../guides/ssh.md) has the rest.

## URLs

| Where                  | URL                                    |
| ---------------------- | -------------------------------------- |
| Host                   | `http://<name>.imp.localhost:7080`     |
| Tailnet                | `http://<tailnet-host>:<20000 + slot>` |
| Tailnet, with a domain | `https://<name>.<domain>`              |
| Tailnet, per-imp names | `https://<name>.<tailnet>.ts.net`      |
| Internet, public imps  | `https://<name>.<domain>`              |

MagicDNS does not support wildcard names, so on the tailnet each imp has a port, not a hostname. A
domain of your own fills that gap: its wildcard record points at the host's tailnet IP
([why](../guides/https.md#why-the-records-point-at-the-tailnet-ip)). It is the recommended way.
Per-imp names, opt-in, make each imp a Tailscale Service instead
([per-imp names](../guides/tailscale.md#per-imp-names)). `imp url <name>` prints the domain's https
URL first, when there is one, then the imp's own tailnet name, then the others. An imp made
[public](../guides/https.md#public-imps) keeps its name, but its own record points at the host's
public IP, where a second listener serves public imps only. The
[Tailscale guide](../guides/tailscale.md) covers the tailnet node, the ACL and HTTPS.
