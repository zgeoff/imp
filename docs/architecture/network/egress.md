# Egress

Each imp has an egress policy: what it may reach directly, past the host container. A coding agent
in an imp runs code a prompt injection can take over, so the policy is the owner's way to keep an
imp off what it should not reach. Hosts that a grant covers stay reachable under every policy,
through [the credential broker](./broker.md), which dials them from the host container that this
firewall does not filter. [Networking](./networking.md) covers the base firewall the policies sit
on.

| Policy   | The imp reaches                                                                |
| -------- | ------------------------------------------------------------------------------ |
| `open`   | anything but the metadata range, the tailnet and the blocked IPv6 ranges       |
| `public` | the global internet only                                                       |
| `box`    | the addresses its allow-list's names resolve to, and the ranges the list names |
| `none`   | nothing                                                                        |

`open` is the default. A policy change applies at once, whatever the imp's state, because the table
is keyed by slot. A fork and a backup restore carry the policy. When the new policy is narrower,
impd deletes the guest's connection tracking entries, so a flow the policy now denies ends on its
next packet, and the broker closes the imp's tunnels that the new policy denies, since those are
relays in impd that connection tracking never sees.

## The firewall

impd owns one nftables table and writes it whole, in one transaction, at start and on every create,
destroy, policy change and network change. DNS answers and expiries change only its sets. Its
forward chain runs before the base rules and only drops and rejects, so the base rules still accept
what it lets through.

- A verdict map sends each tap to its slot's chain, and a tap with no entry is refused. Each slot
  chain first drops any source but the guest's own addresses.
- Traffic between two members of one private network is accepted and marked first; any other packet
  from one tap to another is refused before a slot chain sees it, so no policy can accept it.
- A `box` chain accepts its list's ranges, refuses every private, shared and blocked range and the
  imp range, then accepts the addresses in its set, and refuses the rest.
- A refusal is a TCP reset, or ICMP admin-prohibited for anything else, because a reset ends a live
  connection at once where ICMP alone leaves it retrying.

impd writes a new imp's chain in the same step as its row, before its tap comes up, and takes a
destroyed imp's chain out before its slot is free. Where nft cannot run, no `public`, `box` or
`none` imp boots or wakes, and impd refuses those policies.

## The resolver

A `public`, `box` or `none` imp's DNS goes to impd's own resolver: a redirect on the guest's port 53
to anything outside the imp range sends it to the resolver on the imp's gateway, and impd knows the
imp by the source address. Only IPv4 DNS is redirected, because the guest's resolver names IPv4
servers; port 53 over IPv6 meets the policy as any other port does, so a `public` imp can ask a
global IPv6 resolver directly, and a `box` imp only one its list allows. A name the policy does not
allow gets REFUSED with a "prohibited" extended error and never leaves the host, and a query past
the imp's rate limit gets plain REFUSED, so the two can be told apart.

For an allowed name, the resolver asks upstream, puts the addresses on the answer's CNAME chain into
the imp's set, and only then replies, so the guest's first connection finds its address already
allowed. Each address expires at its TTL, within bounds, and the resolver caps the TTLs it hands
back below the shortest an address stays in the set, so a guest asks again before its address can
expire. An impd restart starts the sets empty and resolves each box's exact names when it builds the
table, so a guest that cached them reaches them again at once.

The firewall works on addresses. A CDN address an allowed name resolved to stays allowed for its
TTL, and with it every other name that address serves, DNS over HTTPS through it included.

## Public

A `public` imp reaches the global internet and nothing else: not the host, impd, other imps unless a
network puts both on it, the tailnet, or link-local and private networks. Its chain refuses a packet
that would leave by any interface but a default route's of its family, so a tailnet, a subnet route
or a second Docker network is refused whatever address it carries. It then refuses every range the
IANA special-purpose registries mark not globally reachable, the imp range, the container's own
networks, the host's own addresses with their prefixes, and any range the owner adds. A route read
that fails fails closed, and refuses everything.

The host container runs in a namespace of its own, so the Docker host's own networks are in none of
the container's prefixes. The host's unit and the NixOS module therefore read the host's global
addresses, each with its prefix, at every start of the container, and impd denies those whole
networks to a public imp, the host's neighbours on them included. The addresses are read only at
that start, so a network the host joins later stays reachable until the next start. Routing on the
host is the owner's boundary: a host that itself forwards a global address to a private service
needs that address in the deny list.

## Networks

A private network lets its imps reach one another, IPv4 only. Each network is a set of tap and
address pairs, and its rule checks both ends, each against its own tap, so a guest that sends from
another address matches nothing. A match sets a mark bit that the base rules accept ahead of their
tap-to-tap drop. The rules come before the policies, so a network reaches past `box` and `none`. A
change whose table nft refuses puts its rows back, so a failed leave never leaves a pair connected
that the rows part, and a pair that no longer shares a network has its connections reset.

impd's resolver answers each member's name in the network's zone and every reverse name in the imp
range itself, before the policy's verdict, so none is ever forwarded, and a name the asker shares no
network with does not exist. With no nft, nothing marks a packet, and the base drop takes all
tap-to-tap traffic: networks fail closed.
