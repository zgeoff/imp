# Networking

Every imp gets its own tap device and its own /30, routed through the host container. No two imps
share a layer-2 network, so they cannot see each other. The wake proxy gives each imp an HTTP URL on
the host and on the tailnet, and an HTTPS URL on your own domain when one is set. The credential
broker listens on every imp's gateway.

## Addressing

- impd carves guest subnets out of `IMP_SUBNET` (default `10.66.0.0/16`). Slot `n` owns the /30 at
  offset `4n`: the host end is `4n+1`, the guest `4n+2`.
- The tap is `imp<slot>`. The guest MAC is `06:00` followed by the guest IP in hex.
- An imp keeps its slot for its whole life, so the tap name and the IP survive a sleep and a
  restore. A container restart removes the taps; a wake creates the tap again before it loads the
  snapshot.
- Guest DNS: `IMP_DNS` (default `1.1.1.1,8.8.8.8`), passed on the kernel command line. A `box` or
  `none` imp's queries go to impd's resolver whatever the guest asks ([Egress](#egress)).

## iptables

`host/scripts/setup-net.sh` sets the rules when the host container starts. They live in the
container's own network namespace and never touch the host's.

- `MASQUERADE` for the imp subnet out of the container's default route.
- `FORWARD -i imp+ -o imp+ DROP`: no imp-to-imp traffic.
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
- `ip6tables INPUT -i imp+` drops everything. The taps get IPv6 link-local addresses, and impd's API
  and proxy listen on IPv6 too; without this rule a guest reaches them over its tap.
- The egress resolver's port, `IMP_EGRESS_DNS_PORT` (default 7053), is accepted from the taps over
  UDP and TCP and dropped in `raw PREROUTING` from anywhere else, as the broker's is. The rules
  carry the comment `imp-egress-dns`.
- The TCP MSS of guest connections is clamped to the real uplink MTU (`IMP_UPLINK_MTU`). Behind a
  smaller-MTU uplink (WSL's is 1360), frag-needed ICMP never reaches the guests, and large TLS
  records stall.

## Egress

Each imp has an egress policy: what it may reach directly, past the host container.

| Policy | The imp reaches                                                                        |
| ------ | -------------------------------------------------------------------------------------- |
| `open` | anything but `169.254.0.0/16` (metadata services) and `100.64.0.0/10` (the tailnet)    |
| `box`  | the addresses its allow-list's names resolve to, and the address ranges the list names |
| `none` | nothing                                                                                |

Hosts a [grant](../guides/connectors.md) covers stay reachable under every policy, through the
credential broker: it dials them from the host container, which this firewall does not filter.
`open` is the default. `imp new --policy box --allow github.com,*.npmjs.org` sets one at create, and
`imp policy <name> box --allow …`, `open` or `none` changes it; `imp policy <name>` shows it. An
allow entry is a hostname, `*.` and a hostname for every name under it (not the name itself), or an
IPv4 address or CIDR, the only way a box reaches a private address. A fork and a backup restore
carry the policy.

### The firewall

impd owns the nftables table `inet imp_egress` and writes it whole, in one `nft -f` transaction, at
start and on every create, destroy and policy change; DNS answers and expiries change only its sets.
Its `forward` chain runs before iptables' FORWARD and only drops and rejects, so setup-net's rules
still accept what it lets through.

- A verdict map sends each tap (`imp<slot>`) to its slot's chain. A tap with no entry is refused.
- Each slot chain drops any source but the guest's own address: rpfilter passes the other addresses
  of the guest's /30.
- A `box` chain drops `ct state invalid`, lets established flows through, then accepts the list's
  ranges, refuses every range the broker refuses (`REFUSED_RANGES`) and `IMP_SUBNET`, and accepts
  the addresses in its set. Anything else is refused.
- A refusal is a TCP reset, or ICMP admin-prohibited for anything else. A reset ends a live
  connection at once; ICMP alone leaves it retrying.
- IPv6 from a tap is refused: guests have no IPv6 route out.
- impd writes a new imp's chain in the same step as its insert, before its tap comes up, and takes a
  destroyed imp's out before its slot is free. A box or none imp does not boot or wake where nft
  cannot run; impd logs `impd: egress: NO FIREWALL` at start and refuses those policies.

### The resolver

A `box` or `none` imp's DNS goes to impd: a nat redirect sends its UDP and TCP port 53, to any
address, to `IMP_EGRESS_DNS_PORT` on its gateway. impd knows the imp by the source address.

- A name the policy does not allow gets REFUSED with Extended DNS Error 18 ("Prohibited") and never
  leaves the host. A query with more than one question is refused. Each imp has a rate limit; a
  query past it gets plain REFUSED, with no EDE, so the two can be told apart.
- Over TCP, each imp may hold 16 connections, and one idle for 10 s is closed.
- For an allowed name, impd asks `IMP_DNS`, under a fresh random query id, puts the A records on the
  CNAME chain from the name into the imp's set, and only then replies. The chain's names count as
  allowed for their TTL, for a stub resolver that follows the CNAME itself. AAAA gets an empty
  answer.
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
plain tunnels to hosts the new policy denies: they are relays in impd, which conntrack never sees. A
broker connection is tracked from the moment it is accepted, so one whose CONNECT arrives after the
change is held to the new policy.

Known limits:

- The firewall works on addresses. A CDN address that an allowed name resolved to stays allowed, for
  its clamped TTL plus up to 30 s, and with it every other name that address serves.
- So does DNS over HTTPS through an allowed address. DoT and DoH to public resolvers are refused by
  construction: their addresses are in no set unless the list names them.
- A guest that cached a wildcard name's address before an impd restart reaches it again only after
  it asks again: at most 5 minutes.

## The wake proxy

The proxy forwards HTTP and WebSockets to an imp's HTTP port. The port is set at create
(`imp new --http-port`, default 8080).

- **Host routing.** On `IMP_PROXY_PORT` (default 7080), the first label of the Host header names the
  imp: `<name>.imp.localhost:7080`, or any `<name>.<domain>`.
- **One port per imp.** On `IMP_PORT_BASE + slot` (default base 20000), every request goes to that
  imp. The tailnet uses these ports.
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
past the `INPUT` drop, so it refuses every private, shared, loopback and link-local range, IPv6, and
the container's own addresses. The broker also drops a guest that dials another imp's gateway. The
[connectors guide](../guides/connectors.md) has the whole design.

## The SSH gateway

impd's SSH gateway listens on `IMP_SSH_PORT` (default 22) on IPv4, in the container's own network
namespace, like the API. The tailnet reaches it through `tailscale0`, the firewall above keeps the
guests off it, and only `scripts/dev.sh` publishes it, on `127.0.0.1:2222`. Forwards go through the
agent's `dial` from inside the guest, never from the host container to the guest's IP, so a forward
reaches programs that listen on the guest's loopback. The [SSH guide](../guides/ssh.md) has the
rest.

## URLs

| Where                  | URL                                    |
| ---------------------- | -------------------------------------- |
| Host                   | `http://<name>.imp.localhost:7080`     |
| Tailnet                | `http://<tailnet-host>:<20000 + slot>` |
| Tailnet, with a domain | `https://<name>.<domain>`              |

MagicDNS does not support wildcard names, so on the tailnet each imp has a port, not a hostname. A
domain of your own fills that gap: its wildcard record points at the host's tailnet IP
([why](../guides/https.md#why-the-records-point-at-the-tailnet-ip)). `imp url <name>` prints the
https URL first, when there is one, then the others. The [Tailscale guide](../guides/tailscale.md)
covers the tailnet node, the ACL and HTTPS.
