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
- Guest DNS: `IMP_DNS` (default `1.1.1.1,8.8.8.8`), passed on the kernel command line.

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
- `ip6tables INPUT -i imp+` drops everything. The taps get IPv6 link-local addresses, and impd's API
  and proxy listen on IPv6 too; without this rule a guest reaches them over its tap.
- The TCP MSS of guest connections is clamped to the real uplink MTU (`IMP_UPLINK_MTU`). Behind a
  smaller-MTU uplink (WSL's is 1360), frag-needed ICMP never reaches the guests, and large TLS
  records stall.

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
