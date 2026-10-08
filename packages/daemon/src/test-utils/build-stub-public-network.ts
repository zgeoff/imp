// Bash that builds a host's networks in a fresh network and mount namespace:
// guests g0 and g3 behind their taps, an uplink up0 whose neighbour wan
// answers for the internet, and tailscale0 with a subnet route to ts.
export function buildStubPublicNetwork(): string {
  return `
mount -t tmpfs tmpfs /run
mkdir -p /run/netns
# no duplicate address detection: a link-local address still tentative
# makes a guest's first IPv6 packet fail neighbour discovery
sysctl -qw net.ipv6.conf.default.accept_dad=0
sysctl -qw net.ipv4.ip_forward=1
sysctl -qw net.ipv6.conf.all.forwarding=1
for n in 0 3; do
  ip netns add g$n
  ip netns exec g$n sysctl -qw net.ipv6.conf.default.accept_dad=0
  ip link add imp$n type veth peer name eth0 netns g$n
  ip addr add 10.66.0.$((n * 4 + 1))/30 dev imp$n
  ip -6 addr add fd12:3456:789a::$n:1/112 dev imp$n nodad
  ip link set imp$n up
  ip -n g$n addr add 10.66.0.$((n * 4 + 2))/30 dev eth0
  ip -n g$n -6 addr add fd12:3456:789a::$n:2/112 dev eth0 nodad
  ip -n g$n link set eth0 up
  ip -n g$n link set lo up
  ip -n g$n route add default via 10.66.0.$((n * 4 + 1))
  ip -n g$n -6 route add default via fd12:3456:789a::$n:1
done
ip netns add wan
ip netns exec wan sysctl -qw net.ipv6.conf.default.accept_dad=0
ip link add up0 type veth peer name eth0 netns wan
ip addr add 44.0.0.1/24 dev up0
ip -6 addr add 2a00:44::1/64 dev up0 nodad
ip link set up0 up
ip -n wan addr add 44.0.0.2/24 dev eth0
ip -n wan -6 addr add 2a00:44::2/64 dev eth0 nodad
ip -n wan link set eth0 up
ip -n wan link set lo up
for address in 93.184.215.14 10.250.77.1 169.254.169.254 192.88.99.1 8.8.4.4; do
  ip -n wan addr add $address/32 dev lo
done
for address in 2606:4700::1111 64:ff9b::a00:1 2002:a00:1::1 2001:db8:77::1 2a01:4f8::7; do
  ip -n wan -6 addr add $address/128 dev lo nodad
done
ip -n wan route add 10.66.0.0/16 via 44.0.0.1
ip -n wan -6 route add fd12:3456:789a::/64 via 2a00:44::1
ip route add default via 44.0.0.2
ip -6 route add default via 2a00:44::2
ip netns add ts
ip link add tailscale0 type veth peer name eth0 netns ts
ip addr add 100.90.0.1/24 dev tailscale0
ip link set tailscale0 up
ip -n ts addr add 100.90.0.2/24 dev eth0
ip -n ts addr add 1.2.3.4/32 dev lo
ip -n ts link set eth0 up
ip -n ts link set lo up
ip -n ts route add 10.66.0.0/16 via 100.90.0.1
ip route add 1.2.3.0/24 via 100.90.0.2 dev tailscale0
`;
}
