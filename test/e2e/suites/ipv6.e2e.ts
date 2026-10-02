import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp, waitForExec } from '../lib/imps';
import {
  instance,
  readImpdLogTail,
  runChecked,
  runCommand,
  runDevScript,
  runInContainer,
} from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// IPv6 for imps (docs/architecture/networking.md#ipv6). The dev instance
// joins a Docker IPv6 network; a router container leads on to a narrower
// network (MTU 1280) with the server, so packet-too-big comes from beyond.

const prefix = setupSuite('ipv6');
const TINY = resolveImageName('e2e-tiny');
const RA = resolveImageName('e2e-ra');
const open = `${prefix}open`;
const box = `${prefix}box`;
const none = `${prefix}none`;
const rogue = `${prefix}ra`;

const names = {
  near: `${instance.container}-v6`,
  far: `${instance.container}-v6far`,
  router: `${instance.container}-v6-router`,
  server: `${instance.container}-v6-server`,
};

const NEAR = '2001:db8:6a::';
const FAR = '2001:db8:6b::';
const ROUTED = '2001:db8:6c::';
const ROUTER_NEAR = `${NEAR}100`;
const ROUTER_FAR = `${FAR}100`;

// the server answers on both; a box imp may reach only the first
const SERVER = `${FAR}200`;
const SERVER_OTHER = `${FAR}201`;

// a port on the dev container, for a guest to try
const HOST_PORT = 7099;
const UPLOAD_BYTES = 524_288;
const BIG_BYTES = 2_097_152;

// The server sends what fits the far network, but asks for full segments,
// as a server on a wider link would: the guest's must shrink on the way.
const WIDE_MSS = 'mtu 1280 advmss 1440';

// busybox httpd: a page, a big file, the peer's address and an upload sink
const SERVER_SCRIPT = [
  'mkdir -p /www/cgi-bin',
  'echo v6-ok > /www/index.html',
  `head -c ${String(BIG_BYTES)} /dev/zero > /www/big`,
  `printf '#!/bin/sh\\necho Content-Type: text/plain\\necho\\necho $REMOTE_ADDR\\n' > /www/cgi-bin/peer`,
  `printf '#!/bin/sh\\necho Content-Type: text/plain\\necho\\nwc -c\\n' > /www/cgi-bin/upload`,
  'chmod +x /www/cgi-bin/peer /www/cgi-bin/upload',
  `ip -6 addr add ${SERVER_OTHER}/64 dev eth0`,
  `ip -6 route add ${NEAR}/64 via ${ROUTER_FAR} ${WIDE_MSS}`,
  `ip -6 route add ${ROUTED}/64 via ${ROUTER_FAR} ${WIDE_MSS}`,

  // port 53 over TCP, where a guest might try DNS
  'httpd -p [::]:53 -h /www',
  'exec httpd -f -p [::]:80 -h /www',
].join(' && ');

const V6_ENV = {
  IMP_DEV_NETWORK: names.near,

  // larger than the far network: only packet-too-big gets a full segment through
  IMP_UPLINK_MTU: '1500',
  IMP_SUBNET6: 'auto',
};

const ROUTED_ENV = { ...V6_ENV, IMP_SUBNET6: `${ROUTED}/64` };

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

// A failed run leaves the dev instance on the near network; the reboot
// that follows puts it back.
async function stopTopology(): Promise<void> {
  await runCommand(['docker', 'network', 'disconnect', '-f', names.near, instance.container]);
  await runCommand(['docker', 'rm', '-f', names.router, names.server]);
  await runCommand(['docker', 'network', 'rm', names.near, names.far]);
}

async function startTopology(): Promise<void> {
  await stopTopology();
  await runChecked([...CREATE_NETWORK, '--subnet', `${NEAR}/64`, names.near]);

  await runChecked([
    ...CREATE_NETWORK,
    '--subnet',
    `${FAR}/64`,
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
    ROUTER_NEAR,
    '--cap-add',
    'NET_ADMIN',
    '--sysctl',
    'net.ipv6.conf.all.forwarding=1',
    'busybox:1.37',
    'sleep',
    'infinity',
  ]);

  await runChecked(['docker', 'network', 'connect', '--ip6', ROUTER_FAR, names.far, names.router]);
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
    SERVER,
    '--cap-add',
    'NET_ADMIN',
    'busybox:1.37',
    'sh',
    '-c',
    SERVER_SCRIPT,
  ]);
}

// The dev container's address on the near network, which NAT66 hides
// imps behind, and which a routed /64 goes through.
async function readHostAddress(): Promise<string> {
  const address = await runChecked([
    'docker',
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${names.near}").GlobalIPv6Address}}`,
    instance.container,
  ]);

  return address.trim();
}

// Reboots the dev instance with the env. A reboot makes a new container,
// without the route to the far network.
async function startInstance(env: Readonly<Record<string, string>>): Promise<string> {
  Object.assign(process.env, env);

  await runDevScript('reboot');
  await runInContainer(['ip', '-6', 'route', 'replace', `${FAR}/64`, 'via', ROUTER_NEAR]);

  return readHostAddress();
}

beforeAll(async () => {
  await startTopology();
  await startInstance(V6_ENV);
  await createImp(open, '--image', TINY, '--memory', '256');
  await createImp(box, '--image', TINY, '--memory', '256', '--policy', 'box', '--allow', SERVER);
  await createImp(none, '--image', TINY, '--memory', '256', '--policy', 'none');

  for (const name of [open, box, none]) {
    await holdImp(name);
  }
}, 900_000);

afterAll(async () => {
  for (const key of Object.keys(ROUTED_ENV)) {
    delete process.env[key];
  }

  await runDevScript('reboot');
  await stopTopology();
}, 900_000);

// the shell exits 0 when the command did
async function tryInImp(name: string, script: string): Promise<boolean> {
  const result = await tryImp(['exec', name, '--', 'sh', '-c', script]);

  return result.exitCode === 0;
}

function tryGetFromImp(name: string, url: string): Promise<boolean> {
  return tryInImp(name, `wget -q -T 5 -O /dev/null ${url}`);
}

function readFromImp(name: string, url: string): Promise<string> {
  return runShellInImp(name, `wget -q -T 10 -O- ${url}`);
}

function tryDialFromImp(name: string, target: string, port: number, source = ''): Promise<boolean> {
  const from = source === '' ? '' : `-s ${source}`;

  return tryInImp(name, `echo | nc -w 3 ${from} ${target} ${String(port)} >/dev/null`);
}

// the guest's global address
async function readGuestAddress(name: string): Promise<string> {
  const addresses = await runShellInImp(name, 'ip -6 addr show dev eth0 scope global');

  return /inet6 (?<address>[\da-f:]+)\/128/.exec(addresses)?.groups?.['address'] ?? '';
}

// The address impd gives a guest: the prefix, then its IPv4 address as the
// interface ID (10.66.0.6 is ::a42:6).
async function buildExpectedAddress(name: string, network: string): Promise<string> {
  const row = await requireImp(name);

  const [a = 0, b = 0, c = 0, d = 0] = row.ip.split('.').map(Number);
  const high = ((a << 8) | b).toString(16);
  const low = ((c << 8) | d).toString(16);

  return `${network}${high}:${low}`;
}

function readUlaNetwork(log: string): string {
  const found = /impd: ipv6: (?<network>fd[\da-f:]+::)\/64, NAT66/.exec(log)?.groups?.['network'];

  if (found === undefined) {
    throw new Error(`impd logged no NAT66 prefix:\n${log}`);
  }

  return found;
}

test('an imp gets a /128 in the ULA prefix and a default route via fe80::1', async () => {
  const log = await readImpdLogTail(400);
  const address = await readGuestAddress(open);
  const expected = await buildExpectedAddress(open, readUlaNetwork(log));
  const routes = await runShellInImp(open, 'ip -6 route');

  expect(address).toBe(expected);
  expect(routes).toContain('default via fe80::1 dev eth0');
});

test('an open imp reaches IPv6 hosts beyond the host, behind NAT66', async () => {
  const hostAddress = await readHostAddress();
  const page = await readFromImp(open, `http://[${SERVER}]/`);
  const peer = await readFromImp(open, `http://[${SERVER}]/cgi-bin/peer`);

  expect(page).toBe('v6-ok');
  expect(peer).toBe(`[${hostAddress}]`);
});

test("packet-too-big from a router beyond the host reaches the guest's upload", async () => {
  // the router beyond the host refuses the guest's full segments, and the
  // host must let its packet-too-big through to the guest
  const uploaded = await runShellInImp(
    open,
    [
      // httpd hands a CGI no NUL bytes
      `head -c ${String(UPLOAD_BYTES)} /dev/zero | tr '\\0' a > /tmp/up`,
      `wget -q -T 20 -O- --post-file=/tmp/up http://[${SERVER}]/cgi-bin/upload`,
    ].join(' && '),
  );

  const tooBig = await runShellInImp(open, 'grep Icmp6InPktTooBigs /proc/net/snmp6');

  expect(uploaded.trim()).toBe(String(UPLOAD_BYTES));
  expect(Number(tooBig.split(/\s+/).at(-1))).toBeGreaterThan(0);
});

test('a download crosses the narrower network', async () => {
  const size = await runShellInImp(open, `wget -q -T 20 -O- http://[${SERVER}]/big | wc -c`);

  expect(size.trim()).toBe(String(BIG_BYTES));
});

test('a box imp reaches the IPv6 addresses it allows, and nothing else', async () => {
  const allowed = await tryGetFromImp(box, `http://[${SERVER}]/`);

  const denied = [
    await tryGetFromImp(box, `http://[${SERVER_OTHER}]/`),
    await tryGetFromImp(box, `http://[${ROUTER_NEAR}]/`),
  ];

  // the open imp reaches the other address, so it is the policy that refuses
  const control = await tryGetFromImp(open, `http://[${SERVER_OTHER}]/`);

  expect(allowed).toBeTrue();
  expect(denied).toEqual([false, false]);
  expect(control).toBeTrue();
});

// DNS is redirected to impd's resolver over IPv4 only; a box imp's port 53
// over IPv6 meets its policy like any other port: open to an address its
// list allows, refused to any other, so no query leaks out.
test('a box imp sends DNS over IPv6 only to an address its list allows', async () => {
  const query = await tryInImp(box, `nslookup example.com ${SERVER_OTHER}`);
  const overTcp = await tryGetFromImp(box, `http://[${SERVER_OTHER}]:53/`);
  const allowed = await tryGetFromImp(box, `http://[${SERVER}]:53/`);

  // the open imp reaches port 53 there, so it is the policy that refuses
  const control = await tryGetFromImp(open, `http://[${SERVER_OTHER}]:53/`);

  expect(query).toBeFalse();
  expect(overTcp).toBeFalse();
  expect(allowed).toBeTrue();
  expect(control).toBeTrue();
});

test('a none imp reaches nothing over IPv6', async () => {
  const reached = await tryGetFromImp(none, `http://[${SERVER}]/`);

  expect(reached).toBeFalse();
});

test('an imp reaches no other imp, and not the host, over IPv6', async () => {
  const boxAddress = await readGuestAddress(box);
  const hostAddress = await readHostAddress();

  await runCommand([
    'docker',
    'exec',
    '-d',
    instance.container,
    'bun',
    '-e',
    `Bun.listen({ hostname: '::', port: ${String(HOST_PORT)}, socket: { open: (s) => { s.end('hi\\n'); }, data: () => {} } })`,
  ]);

  // the router, not an imp, does reach the host's port
  const fromRouter = await runCommand([
    'docker',
    'exec',
    names.router,
    'sh',
    '-c',
    `echo | nc -w 3 ${hostAddress} ${String(HOST_PORT)}`,
  ]);

  const reached = [
    await tryGetFromImp(open, `http://[${boxAddress}]:8080/`),
    await tryDialFromImp(open, hostAddress, HOST_PORT),
    await tryDialFromImp(open, 'fe80::1%eth0', HOST_PORT),
    await tryInImp(open, `ping -c 1 -W 2 ${ROUTER_NEAR}`),
  ];

  // the router's far side is not on a network the host is on
  const control = await tryInImp(open, `ping -c 1 -W 2 ${ROUTER_FAR}`);

  expect(fromRouter.stdout.trim()).toBe('hi');
  expect(reached).toEqual([false, false, false, false]);
  expect(control).toBeTrue();
});

// Spoofed from outside the prefix, and as another imp. The host's rpfilter
// drops both before the slot chain's own source check, which the ruleset
// test covers.
test('a spoofed IPv6 source is dropped', async () => {
  const own = await readGuestAddress(open);
  const boxAddress = await readGuestAddress(box);

  const spoofs = [`${FAR}77`, boxAddress];

  // before the spoofed addresses, which the guest would pick as its source
  const control = await tryDialFromImp(open, SERVER, 80);

  const add = spoofs.map((address) => `ip -6 addr add ${address}/128 dev eth0`);
  const remove = spoofs.map((address) => `ip -6 addr del ${address}/128 dev eth0`);

  await runShellInImp(
    open,
    ['echo 0 > /proc/sys/net/ipv6/conf/eth0/accept_dad', ...add].join(' && '),
  );

  const fromOwn = await tryDialFromImp(open, SERVER, 80, own);

  const fromSpoofs = await Promise.all(
    spoofs.map((address) => tryDialFromImp(open, SERVER, 80, address)),
  );

  await runShellInImp(open, remove.join(' && '));

  expect(control).toBeTrue();
  expect(fromOwn).toBeTrue();
  expect(fromSpoofs).toEqual([false, false]);
});

// the packets ip6tables' INPUT has dropped from the taps
async function readTapDrops(): Promise<number> {
  const result = await runInContainer(['ip6tables', '-w', '-vnxL', 'INPUT']);

  const line = result.stdout
    .split('\n')
    .find((row) => row.includes('DROP') && row.includes('imp+'));

  return Number(line?.trim().split(/\s+/)[0] ?? Number.NaN);
}

async function readHostRouting(): Promise<string> {
  const result = await runInContainer(['sh', '-c', 'ip -6 route; ip -6 addr show scope global']);

  return result.stdout;
}

test("a guest's router advertisement changes no route or address on the host", async () => {
  await createImp(rogue, '--image', RA, '--memory', '256');

  const before = await readHostRouting();
  const droppedBefore = await readTapDrops();

  await runShellInImp(rogue, `ra-send eth0 2001:db8:66::/64`);

  // the host would act on it at once; a second is ample
  await Bun.sleep(1000);

  const after = await readHostRouting();
  const droppedAfter = await readTapDrops();

  expect(after).toBe(before);
  expect(after).not.toContain('2001:db8:66');

  // it did reach the host, which dropped it
  expect(droppedAfter).toBeGreaterThan(droppedBefore);
});

test('an imp keeps its IPv6 address over sleep and wake', async () => {
  const before = await readGuestAddress(open);

  await runImp('sleep', open);
  await waitForExec(open);

  const after = await readGuestAddress(open);
  const reached = await tryGetFromImp(open, `http://[${SERVER}]/`);

  expect(after).toBe(before);
  expect(reached).toBeTrue();
});

test('a routed /64: each imp dials out from its own address, after a cold boot', async () => {
  const hostAddress = await startInstance(ROUTED_ENV);

  await runCommand([
    'docker',
    'exec',
    names.router,
    'ip',
    '-6',
    'route',
    'replace',
    `${ROUTED}/64`,
    'via',
    hostAddress,
  ]);

  // asleep after the reboot; its snapshot holds the old prefix
  await waitForExec(open);

  const address = await readGuestAddress(open);
  const expected = await buildExpectedAddress(open, ROUTED);

  expect(address).toBe(expected);

  await waitFor('the routed address to reach the server', async () => {
    const peer = await readFromImp(open, `http://[${SERVER}]/cgi-bin/peer`);

    expect(peer).toBe(`[${expected}]`);
  });

  const log = await readImpdLogTail(400);

  expect(log).toContain('the IPv6 prefix changed');
});
