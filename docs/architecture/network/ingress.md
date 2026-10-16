# Ingress

Traffic reaches an imp's own servers by four routes, and every one of them goes through impd, which
wakes the imp first: the wake proxy for HTTP, the SSH gateway, tunnels from `impz proxy`, and
reverse forwards that run the other way. impd listens inside the host container's own namespace, the
host publishes its ports on loopback only, and the tailnet reaches them through the container's own
tailscaled. [The API](../control/api.md#exec-and-tunnels) covers the WebSockets that carry tunnels,
and [auth](../control/auth.md) who may open them.

## The wake proxy

The proxy forwards HTTP and WebSockets to an imp's HTTP port. It routes by two means. On the proxy
port, the first label of the Host header names the imp, as `<name>.imp.localhost` on the host or
`<name>.<domain>` under an HTTPS domain. And each imp has a port of its own, by its slot, where
every request goes to that imp. The tailnet uses those ports, because MagicDNS has no wildcard
names, so on the tailnet each imp has a port, not a host name. impd refuses to start when its own
ports fall in the per-imp range.

A request asks the lifecycle for a running VM, which wakes a sleeping imp or boots a stopped one,
and then goes to the guest's address from the host container. A response that needed a wake says how
long it took in a header. The proxy sends `Connection: close` upstream, so a finished request leaves
no keep-alive socket in the guest that would keep it awake. The proxy lifts its fetch's limit on a
silent answer, so a long poll in the guest or a long call to impd's API ends only when its client
gives up, and the client's going ends the upstream request. WebSockets are relayed message by
message.

The proxy is open to anything that can reach it; the tailnet's ACL is the boundary. Browsers send a
host's cookies to every port of that host, and imps serve pages on other ports of impd's own host,
so the proxy strips the dashboard's session cookie from every request it forwards
([auth](../control/auth.md#the-dashboard-session)).

## HTTPS on a domain

With a domain of its own, impd serves every imp at `https://<name>.<domain>` on the tailnet. It gets
one wildcard certificate for the domain by ACME's DNS challenge, renews it well before it expires,
and points the domain's wildcard record at the host's tailnet address. The TLS listener binds the
tailnet address and loopback only, never every address, so a port Docker publishes to the internet
never reaches it. It hands each request to the wake proxy, and accepts exactly `<name>.<domain>` for
an imp and `<domain>` for impd's API, so the bare domain never reaches an imp. A renewed certificate
starts a second listener beside the old one, which lets its open connections finish, because Bun
cannot change a running server's certificate. The [HTTPS guide](../../guides/https.md) covers the
setup and the records.

A public imp is the one route from the internet, and the owner opts each imp in. A second pair of
listeners, on every address, serves public imps only, behind credentials the owner sets per imp. The
listener a request arrives on decides what it may reach, never the client's address, because
Docker's userland proxy can make a public client look like the bridge. Anything that is not a public
imp gets the same not-found answer, so the internet cannot tell which names exist. Each public imp
has limits on open requests, wakes and wrong credentials, counted per imp, and its own DNS record at
the host's public address, which wins over the tailnet wildcard. A public imp never moves to another
host.

## Per-imp tailnet names

As an opt-in, each imp becomes a Tailscale Service of its own, served by the container's tailscaled
to the imp's own proxy port, so a request through the name wakes the imp as any other does and can
never reach impd's API. impd owns only the services it tagged and marked with this host's ID, and
never overwrites one it does not own. A pass after every create and destroy, and on a timer, makes
and removes the services, and a failure fails that name only, never the create.

## The SSH gateway

The SSH gateway runs inside impd on `ssh2`, so it reaches the lifecycle, the activity counts and the
agent client directly; a separate SSH server would need the exec protocol again. The SSH user names
the imp, and a login needs `exec` scope on it. Public keys are the only login: a key bound to a
token, or the authorized-keys file. The key check, the scope check and the imp lookup give the same
refusal, and nothing before a verified signature for a known imp touches the imp. A login opens an
SSH connection in the activity counts and starts the wake, and channels wait for it.

A shell, a command or SFTP is an agent exec, as `impz exec` is, and SFTP runs the system drive's
server, so every image gets SFTP. A local forward dials from inside the guest through the agent, so
it reaches servers that listen on the guest's loopback only, and a remote forward listens in the
guest through the agent. Agent forwarding puts a socket in the guest whose clients become channels
back to the user's ssh-agent. Client input waits until the agent connection took the last chunk, so
a slow guest holds back the client's SSH window instead of growing impd's memory. `ssh2` has no
post-quantum key exchange, and recent OpenSSH clients warn about it.

## Tunnels and reverse forwards

`impz proxy` makes ports in an imp reachable on the caller's machine. The CLI listens locally and
opens one tunnel WebSocket per TCP connection, and impd wakes the imp and dials the port inside the
guest through the agent, so a server on the guest's loopback is reachable. An open tunnel counts as
a connection, so it keeps the imp awake, and a forced sleep resets it. A reverse forward runs the
other way: impd asks the agent to listen on a socket or a port in the guest, and each client that
connects becomes a relay to the caller's machine. A reverse forward belongs to its caller and its
imp, and a listener with no clients keeps nothing awake, so a forward alone lets the imp sleep; the
CLI waits for the imp's next wake on the event stream, without waking it, and listens again.
