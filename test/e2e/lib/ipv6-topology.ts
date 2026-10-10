import { runShellInImp } from './imp-cli';
import { instance, runChecked, runCommand, runDevScript, runInContainer } from './instance';

// The ipv6 suite's network (docs/architecture/networking.md#ipv6): a router
// leads from the instance's Docker IPv6 network to a narrower one (MTU 1280)
// with the server, so packet-too-big comes from beyond the host.

export interface V6Plan {
  // three /64s: the instance's network, the server's, and one routed to the host
  readonly near: string;
  readonly far: string;
  readonly routed: string;
  readonly routerNear: string;
  readonly routerFar: string;

  // the server answers on both; a box imp may reach only the first
  readonly server: string;
  readonly serverOther: string;
}

// Three /64s of the documentation range per instance, so instances side by
// side never ask Docker for the same pool: 6a, 6b and 6c at offset 0.
export function buildV6Plan(portOffset: number): V6Plan {
  const block = 0x6a + 3 * portOffset;
  const buildPrefix = (index: number) => `2001:db8:${(block + index).toString(16)}::`;
  const near = buildPrefix(0);
  const far = buildPrefix(1);

  return {
    near,
    far,
    routed: buildPrefix(2),
    routerNear: `${near}100`,
    routerFar: `${far}100`,
    server: `${far}200`,
    serverOther: `${far}201`,
  };
}

// The address a guest gets in a /64, worked out by hand: the prefix, then
// the guest's IPv4 address as the interface ID (10.66.0.6 is ::a42:6).
export function buildGuestIpv6(network: string, ipv4: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split('.').map(Number);

  return `${network}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

// the ULA /64 impd logged for NAT66
export function parseUlaNetwork(log: string): string {
  const found = /impd: ipv6: (?<network>fd[\da-f:]+::)\/64, NAT66/v.exec(log)?.groups?.['network'];

  if (found === undefined) {
    throw new TypeError(`impd logged no NAT66 prefix:\n${log}`);
  }

  return found;
}

// the first global /128 of `ip -6 addr show`, '' for none
export function parseGlobal128(addresses: string): string {
  return /inet6 (?<address>[\da-f:]+)\/128/v.exec(addresses)?.groups?.['address'] ?? '';
}

// the packet count of ip6tables' INPUT rule that drops from the taps
export function parseTapDrops(listing: string): number {
  const line = listing.split('\n').find((row) => row.includes('DROP') && row.includes('imp+'));

  return Number(line?.trim().split(/\s+/v)[0] ?? Number.NaN);
}

// Thin glue over Docker, the dev instance and live guests below.

export interface V6Names {
  readonly near: string;
  readonly far: string;
  readonly router: string;
  readonly server: string;
}

// the networks and containers, named after the dev container
export function buildV6Names(container: string): V6Names {
  return {
    near: `${container}-v6`,
    far: `${container}-v6far`,
    router: `${container}-v6-router`,
    server: `${container}-v6-server`,
  };
}

// busybox httpd: a page, a 2 MiB file, the peer's address and an upload sink
function buildServerScript(plan: Readonly<V6Plan>): string {
  // the server sends what fits the far network, but asks for full segments,
  // as a server on a wider link would: the guest's must shrink on the way
  const wideMss = 'mtu 1280 advmss 1440';

  return [
    'mkdir -p /www/cgi-bin',
    'echo v6-ok > /www/index.html',
    'head -c 2097152 /dev/zero > /www/big',
    String.raw`printf '#!/bin/sh\necho Content-Type: text/plain\necho\necho $REMOTE_ADDR\n' > /www/cgi-bin/peer`,
    String.raw`printf '#!/bin/sh\necho Content-Type: text/plain\necho\nwc -c\n' > /www/cgi-bin/upload`,
    'chmod +x /www/cgi-bin/peer /www/cgi-bin/upload',
    `ip -6 addr add ${plan.serverOther}/64 dev eth0`,
    `ip -6 route add ${plan.near}/64 via ${plan.routerFar} ${wideMss}`,
    `ip -6 route add ${plan.routed}/64 via ${plan.routerFar} ${wideMss}`,

    // port 53 over TCP, where a guest might try DNS
    'httpd -p [::]:53 -h /www',
    'exec httpd -f -p [::]:80 -h /www',
  ].join(' && ');
}

// Docker drops what is routed to a container from another bridge, which is
// the router's whole job here; unprotected lets it through.
const CREATE_NETWORK = [
  'docker',
  'network',
  'create',
  '--ipv6',
  '-o',
  'com.docker.network.bridge.gateway_mode_ipv6=nat-unprotected',
];

export async function stopV6Topology(): Promise<void> {
  const names = buildV6Names(instance.container);

  await runCommand(['docker', 'network', 'disconnect', '-f', names.near, instance.container]);
  await runCommand(['docker', 'rm', '-f', names.router, names.server]);
  await runCommand(['docker', 'network', 'rm', names.near, names.far]);
}

// the networks, the router and the server; the caller stops them with
// stopV6Topology, after the instance leaves the near network
export async function startV6Topology(plan: Readonly<V6Plan>): Promise<void> {
  const names = buildV6Names(instance.container);

  await stopV6Topology();
  await runChecked([...CREATE_NETWORK, '--subnet', `${plan.near}/64`, names.near]);

  await runChecked([
    ...CREATE_NETWORK,
    '--subnet',
    `${plan.far}/64`,
    '-o',
    'com.docker.network.driver.mtu=1280',
    names.far,
  ]);

  await runChecked([
    'docker',
    'create',
    '--name',
    names.router,
    '--network',
    names.near,
    '--ip6',
    plan.routerNear,
    '--cap-add',
    'NET_ADMIN',
    '--sysctl',
    'net.ipv6.conf.all.forwarding=1',
    'busybox:1.37',
    'sleep',
    'infinity',
  ]);

  await runChecked([
    'docker',
    'network',
    'connect',
    '--ip6',
    plan.routerFar,
    names.far,
    names.router,
  ]);

  await runChecked(['docker', 'start', names.router]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    names.server,
    '--network',
    names.far,
    '--ip6',
    plan.server,
    '--cap-add',
    'NET_ADMIN',
    'busybox:1.37',
    'sh',
    '-c',
    buildServerScript(plan),
  ]);
}

// The dev container's address on the near network, which NAT66 hides imps
// behind, and which a routed /64 goes through.
export async function readV6HostAddress(): Promise<string> {
  const names = buildV6Names(instance.container);

  const address = await runChecked([
    'docker',
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${names.near}").GlobalIPv6Address}}`,
    instance.container,
  ]);

  return address.trim();
}

// Reboots the dev instance onto the near network with its IPv6 settings
// (the subnet: auto for NAT66, or the routed /64), and routes the far
// network through the router, which a new container lacks.
export async function startV6Instance(plan: Readonly<V6Plan>, subnet6: string): Promise<void> {
  await runDevScript('reboot', instance, {
    IMP_DEV_NETWORK: buildV6Names(instance.container).near,

    // wider than the far network: only packet-too-big gets a full segment through
    IMP_UPLINK_MTU: '1500',
    IMP_SUBNET6: subnet6,
  });

  await runInContainer(['ip', '-6', 'route', 'replace', `${plan.far}/64`, 'via', plan.routerNear]);
}

export async function readGuestIpv6(name: string): Promise<string> {
  const addresses = await runShellInImp(name, 'ip -6 addr show dev eth0 scope global');

  return parseGlobal128(addresses);
}

export async function readTapDrops(): Promise<number> {
  const result = await runInContainer(['ip6tables', '-w', '-vnxL', 'INPUT']);

  return parseTapDrops(result.stdout);
}

export async function readHostRouting(): Promise<string> {
  const result = await runInContainer(['sh', '-c', 'ip -6 route; ip -6 addr show scope global']);

  return result.stdout;
}
