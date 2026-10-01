# Networking

Every imp gets its own tap device and its own /30, routed through the host container. No two imps
share a layer-2 network, so they cannot see each other. The wake proxy gives each imp an HTTP URL on
the host and on the tailnet.

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
  dials into guests).
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

## URLs

| Where   | URL                                    |
| ------- | -------------------------------------- |
| Host    | `http://<name>.imp.localhost:7080`     |
| Tailnet | `http://<tailnet-host>:<20000 + slot>` |

MagicDNS does not support wildcard names, so on the tailnet each imp has a port, not a hostname.
`imp url <name>` prints both URLs. The [Tailscale guide](../guides/tailscale.md) covers the tailnet
node, the ACL and HTTPS.
