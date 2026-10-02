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
  [egress policy](../architecture/networking.md#egress) is. A `box` or `none` imp on a network still
  reaches nothing else.
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

## Names

impd answers for the members' names. A guest asks through its usual resolver, `IMP_DNS`: a member's
queries go to impd, which answers these names itself and never sends them upstream. An `open` imp on
no network asks `IMP_DNS` directly, as before, and gets its NXDOMAIN from there.

| Name                                   | Answer                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `<imp>.<network>.internal`             | the imp's address, for an imp on that network with the asker        |
| `<imp>`                                | the same, for a bare name of an imp the asker shares a network with |
| the reverse name of a member's address | `<imp>.<network>.internal`, once for each network the two share     |

- Any other name under `internal`, or under the reverse zone of `IMP_SUBNET`, is NXDOMAIN, the same
  answer whether the name does not exist or names an imp the asker shares no network with. A guest
  cannot list imps through it.
- A bare name that is no peer is resolved as it would be without a network.
- The answers have a TTL of 5 s, so a join or a leave shows soon in a guest's cache.
- An imp's own name answers too: `web.lab.internal` from `web` is its own address.
- A member can run a DNS server for its peers: a query to another imp's address on port 53 goes to
  that imp, not to impd.

## Access

Every network call is host-wide. A [token](./tokens.md) limited to some imps cannot create, delete,
join or leave a network, and cannot pass `--net` to `imp new`: a member reaches every other member,
so a `dev-*` token could reach past its imps. It can list networks, and sees only its own imps in
them. `imp net ls` needs `read`; the other `imp net` commands need `manage`.

## How it works

The [networking page](../architecture/networking.md#networks) covers the firewall rules and the
resolver's part.
