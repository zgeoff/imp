# Private networks

By default no imp can reach another. A network lets a set of imps reach one another: a web imp and
its database, or a build imp and a cache. An imp can be on more than one network, and each network
is separate: two imps reach each other only when they share one.

```sh
imp net create lab                # an empty network
imp new web --net lab             # on lab from its first boot
imp net join lab db               # an existing imp, at once, whatever its state
imp exec web -- ping db           # by its imp name
imp exec web -- ping db.lab.internal
imp net ls                        # NAME  IMPS
imp net leave lab db              # its connections to web end
imp net rm lab                    # every member's connections to the others end
```

`--net` takes a comma-separated list, and each network must exist. Joining twice and leaving a
network the imp is not on do nothing.

## What a network allows

- Every member reaches every other member on any port, over TCP, UDP and ICMP, whatever either one's
  [egress policy](../architecture/networking.md#egress) is. The firewall still holds a `public`,
  `box` or `none` imp to its policy for every address outside the network.
- A non-member reaches no member, and no member reaches it. A packet between two imps that share no
  network is refused: TCP gets a reset, the rest ICMP admin-prohibited.
- IPv4 only: two members do not reach each other over IPv6, and names answer A records only.
- A leave, a `net rm` and an `imp rm` take effect at once. A held connection between two imps that
  no longer share a network gets a reset on its next packet, and impd deletes the pair's conntrack
  entries. A pair that still shares another network keeps its connections.
- A sleeping imp does not wake for a packet from a peer. Hold it (`imp hold`), or wake it first.
- A fork joins no network: a join is a choice made for each imp. A
  [backup](../architecture/backups.md) keeps each imp's network names, and a restore puts the imp
  back on them, making any network that is gone.

## A network is a trust boundary

A network weakens the egress policy of a member whenever an imp that reaches more is on it too. An
`open` peer reaches anything, so it can relay for the others: a proxy, a port forward or a tunnel on
it carries a box imp's traffic anywhere. A `public` peer does the same to the internet for a `box`
or `none` member. A `public`, `box` or `none` imp on a network trusts every open peer on it with its
egress, and a `box` or `none` imp trusts every public peer.

`imp net join` warns when a join puts a `public`, `box` or `none` imp on a network with an `open`
one, or a `box` or `none` imp with a `public` one, from either side, and `--json` carries the same
text in `warning`. `imp new --net` and `imp policy` print the same warning on stderr, one for each
of the imp's networks that mixes them; the API gives them with `networks.warnings`. To keep a box
imp boxed, keep every imp on its networks `box` or `none`.

## Names

impd answers for the members' names. A guest asks through its usual resolver, `IMP_DNS`: a member's
queries go to impd, which answers these names itself and never sends them upstream. An `open` imp on
no network asks `IMP_DNS` directly, as before, and gets its NXDOMAIN from there.

| Name                                   | Answer                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `<imp>.<network>.internal`             | the imp's address, for an imp on that network with the asker        |
| `<imp>`                                | the same, for a bare name of an imp the asker shares a network with |
| the reverse name of a member's address | `<imp>.<network>.internal`, once for each network the two share     |

- Any other name under `<network>.internal` for a network that exists, or under the reverse zone of
  `IMP_SUBNET`, is NXDOMAIN, the same answer whether the name does not exist or names an imp the
  asker shares no network with. A guest cannot list imps through it, though it can tell which
  network names exist.
- Every other `.internal` name, such as `metadata.google.internal` or a company's own, is resolved
  as it would be without a network.
- A bare name that is a peer's imp name gets the peer's address, ahead of anything `IMP_DNS` would
  say for it. Imp names are unique on a host, so two peers never tie. A bare name that is no peer is
  resolved as it would be without a network.
- When the guest shares more than one network with a peer, a reverse lookup answers one name for
  each, sorted by network name.
- The answers have a TTL of 5 s, so a join or a leave shows soon in a guest's cache.
- An imp's own name answers too: `web.lab.internal` from `web` is its own address.
- A member can run a DNS server for its peers: a query to another imp's address on port 53 goes to
  that imp, not to impd.
- An `open` imp on a network sends every query to `IMP_DNS` through impd, so its DNS now depends on
  impd: it stops while impd restarts, and it has a rate limit, higher than a box imp's (a burst of
  2000, then 1000 a second). Off every network, an open imp asks `IMP_DNS` directly again.

## Access

Every network call is host-wide. A [token](./tokens.md) limited to some imps cannot create, delete,
join or leave a network, and cannot pass `--net` to `imp new`: a member reaches every other member,
so a `dev-*` token could reach past its imps. It can list networks, and sees only its own imps in
them. `imp net ls` needs `read`; the other `imp net` commands need `manage`.

## How it works

The [networking page](../architecture/networking.md#networks) covers the firewall rules and the
resolver's part.
