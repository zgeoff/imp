import { requireImp, runShellInImp } from './imp-cli';
import { instance, runChecked, runCommand, runDevScript, runInContainer } from './instance';

// The ipv6 suite's network (docs/architecture/network/networking.md#ipv6): a router
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
  const address = /inet6 (?<address>[\da-f:]+)\/128/v.exec(addresses)?.groups?.['address'];

  if (address === undefined) {
    throw new Error(`no global /128 in ${JSON.stringify(addresses)}`);
  }

  return address;
}

// the packet count of ip6tables' INPUT rule that drops from the taps
// the packets the RS ACCEPT rule of `ip6tables -vnxL INPUT` counted
export function parseRsAccepts(listing: string): number {
  const line = listing
    .split('\n')
    .find((row) => row.includes('ACCEPT') && row.includes('imp+') && row.includes('icmptype 133'));

  if (line === undefined) {
    throw new Error('no RS ACCEPT rule for the taps in INPUT');
  }

  return Number(line.trim().split(/\s+/v)[0]);
}

// The counter table, named with the run's prefix so a leftover is plainly
// the e2e run's.
export function buildRaCounterTable(prefix: string): string {
  return `${prefix}ra`;
}

// A netdev table that counts the tap's router advertisements and
// solicitations on ingress, before any inet hook can drop them.
export function buildRaCounterRuleset(table: string, tap: string): string {
  return [
    `table netdev ${table} {`,
    '  chain ingress {',
    `    type filter hook ingress device "${tap}" priority 0;`,
    '    icmpv6 type nd-router-advert counter',
    '    icmpv6 type nd-router-solicit counter',
    '  }',
    '}',
  ].join('\n');
}

export interface RaCounts {
  readonly adverts: number;
  readonly solicits: number;
}

// the two counters of `nft list table netdev <table>`
export function parseRaCounts(listing: string): RaCounts {
  const readCount = (type: string) => {
    const match = new RegExp(String.raw`${type} counter packets (?<n>\d+)`, 'v').exec(listing);

    const count = match?.groups?.['n'];

    if (count === undefined) {
      throw new Error(`no ${type} counter in ${JSON.stringify(listing)}`);
    }

    return Number(count);
  };

  return { adverts: readCount('nd-router-advert'), solicits: readCount('nd-router-solicit') };
}

// the device the instance routes an address through
export function parseRouteDevice(route: string): string {
  return /\bdev (?<dev>\S+)/v.exec(route)?.groups?.['dev'] ?? '';
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

export async function readRsAccepts(): Promise<number> {
  const result = await runInContainer(['ip6tables', '-w', '-vnxL', 'INPUT']);

  return parseRsAccepts(result.stdout);
}

// the host side of the imp's tap, by the route to its address
export async function readImpTap(name: string): Promise<string> {
  const row = await requireImp(name);
  const route = await runInContainer(['ip', '-o', 'route', 'get', row.ip]);

  return parseRouteDevice(route.stdout);
}

// Refuses a table that is already there: the caller made the container
// anew just before, so one there is not a leftover but something else's.
// The caller stops it with stopRaCounter.
export async function startRaCounter(table: string, tap: string): Promise<void> {
  const listed = await runInContainer(['nft', 'list', 'table', 'netdev', table]);

  if (listed.exitCode === 0) {
    throw new Error(`nft table netdev ${table} is already there`);
  }

  const result = await runCommand(['docker', 'exec', '-i', instance.container, 'nft', '-f', '-'], {
    stdin: buildRaCounterRuleset(table, tap),
  });

  if (result.exitCode !== 0) {
    throw new Error(`nft -f - exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

export async function stopRaCounter(table: string): Promise<void> {
  await runInContainer(['nft', 'delete', 'table', 'netdev', table]);
}

export async function readRaCounts(table: string): Promise<RaCounts> {
  const result = await runInContainer(['nft', 'list', 'table', 'netdev', table]);

  if (result.exitCode !== 0) {
    throw new Error(`nft list table netdev ${table}: ${result.stderr.trim()}`);
  }

  return parseRaCounts(result.stdout);
}

export async function readHostRouting(): Promise<string> {
  const result = await runInContainer([
    'sh',
    '-c',
    'ip -6 route; ip -6 addr show scope global; sysctl net.ipv6.conf.all.accept_ra net.ipv6.conf.default.accept_ra',
  ]);

  return result.stdout;
}
