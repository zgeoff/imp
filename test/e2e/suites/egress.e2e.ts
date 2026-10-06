import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as dnsPacket from 'dns-packet';
import { resolveImageName } from '../lib/fixtures';
import { readInfo, requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { instance, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Egress policies in real guests (docs/architecture/networking.md#egress):
// impd's nft table, its resolver, and the nat redirect of port 53. The
// guests are busybox; the public hosts are example.com and Quad9.

const prefix = setupSuite('egress');
const TINY = resolveImageName('e2e-tiny');
const open = `${prefix}open`;
const box = `${prefix}box`;
const pub = `${prefix}pub`;

// an address no allow-list here names, and no answer adds
const OUTSIDE = '9.9.9.9';

// a server on this machine, which guests reach on the dev container's
// default gateway: a private address, held open for the flush test
const held = { received: 0, accepted: 0 };
const host = { gateway: '', port: 0, stop: () => {} };

async function readContainerGateway(): Promise<string> {
  const route = await runInContainer(['ip', '-4', 'route', 'show', 'default']);

  const found = /via (?<ip>[\d.]+)/v.exec(route.stdout)?.groups?.['ip'];

  if (found === undefined) {
    throw new Error(`no default route in ${instance.container}: ${route.stdout}`);
  }

  return found;
}

beforeAll(async () => {
  host.gateway = await readContainerGateway();

  const listener = Bun.listen({
    hostname: host.gateway,
    port: 0,
    socket: {
      open: (socket) => {
        held.accepted += 1;

        socket.write('hello\n');
      },
      data: (_socket, chunk) => {
        held.received += chunk.byteLength;
      },
    },
  });

  host.port = listener.port;

  host.stop = () => {
    listener.stop(true);
  };

  await createImp(open, '--image', TINY, '--memory', '256');

  await createImp(
    box,
    '--image',
    TINY,
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  await holdImp(open);
  await holdImp(box);
}, 600_000);

afterAll(() => {
  host.stop();
});

// the shell exits 0 when the command did
async function tryInImp(name: string, script: string): Promise<boolean> {
  const result = await tryImp(['exec', name, '--', 'sh', '-c', script]);

  return result.exitCode === 0;
}

function tryGetFromImp(name: string, url: string): Promise<boolean> {
  return tryInImp(name, `wget -q -T 5 -O /dev/null ${url}`);
}

function tryDialFromImp(name: string, target: string, port: number, source = ''): Promise<boolean> {
  const from = source === '' ? '' : `-s ${source}`;

  return tryInImp(name, `echo | nc -w 3 ${from} ${target} ${String(port)} >/dev/null`);
}

test('an open imp reaches the internet and the private gateway', async () => {
  const reached = [
    await tryGetFromImp(open, 'http://example.com/'),
    await tryGetFromImp(open, 'http://example.org/'),
    await tryDialFromImp(open, host.gateway, host.port),
  ];

  expect(reached).toEqual([true, true, true]);

  // the metadata service range is closed to every imp
  const metadata = await tryDialFromImp(open, '169.254.169.254', 80);

  expect(metadata).toBeFalse();
});

test('a box imp reaches its list, and nothing else', async () => {
  const started = performance.now();

  const allowed = await tryGetFromImp(box, 'http://example.com/');

  writeMetric('egressFirstFetchMs', Math.round(performance.now() - started));

  const denied = [
    await tryGetFromImp(box, 'http://example.org/'),
    await tryDialFromImp(box, OUTSIDE, 443),
    await tryDialFromImp(box, host.gateway, host.port),
  ];

  expect(allowed).toBeTrue();
  expect(denied).toEqual([false, false, false]);
});

test('a refused name gets REFUSED with EDE 18, whichever resolver the guest asks', async () => {
  const query = dnsPacket.encode({
    type: 'query',
    id: 26,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name: 'example.org', type: 'A' }],
    additionals: [
      {
        type: 'OPT',
        name: '.',
        udpPayloadSize: 1232,
        extendedRcode: 0,
        ednsVersion: 0,
        flags: 0,
        flag_do: false,
        options: [],
      },
    ],
  });

  // over TCP, which busybox's nc speaks: a length, then the message
  const framed = Buffer.concat([Buffer.from([0, query.byteLength]), query]);
  const octal = [...framed].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');

  const hex = await runShellInImp(box, `printf '${octal}' | nc -w 3 8.8.8.8 53 | od -An -tx1 -v`);

  const bytes = Buffer.from(hex.replaceAll(/\s/gv, ''), 'hex').subarray(2);
  const reply = dnsPacket.decode(bytes);
  const tail = bytes.subarray(-6);

  expect(reply).toMatchObject({ rcode: 'REFUSED', answers: [] });
  expect([tail.readUInt16BE(0), tail.readUInt16BE(4)]).toEqual([15, 18]);
});

test('a guest that sends from another address of its /30 is dropped', async () => {
  const row = await requireImp(box);

  const octets = row.ip.split('.').map(Number);

  // the /30's network address, which the tap's reverse-path check passes
  const other = [...octets.slice(0, 3), (octets[3] ?? 0) - 2].join('.');

  await runShellInImp(box, `ip addr add ${other}/32 dev eth0`);
  await runImp('policy', box, 'box', '--allow', `example.com,${host.gateway}/32`);

  const fromGuest = await tryDialFromImp(box, host.gateway, host.port);
  const fromOther = await tryDialFromImp(box, host.gateway, host.port, other);

  expect([fromGuest, fromOther]).toEqual([true, false]);
});

test('a private address opens only by an explicit CIDR, and a tighter policy cuts its flow', async () => {
  // a flow from the guest that writes every 200 ms until something ends it
  await runShellInImp(
    box,
    `rm -f /tmp/nc-done; setsid sh -c '(while sleep 0.2; do echo x; done | nc ${host.gateway} ${String(host.port)}; echo done > /tmp/nc-done)' </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held flow to carry data', () => {
    expect(held.received).toBeGreaterThan(10);
  });

  await runImp('policy', box, 'box', '--allow', 'example.com');

  await waitFor('the guest to see its flow end', async () => {
    const done = await tryInImp(box, 'test -f /tmp/nc-done');

    expect(done).toBeTrue();
  });

  const policy = await runImp('policy', box);

  expect(policy.trim()).toBe('box: example.com');
});

test('a tighter policy ends broker tunnels it denies, even one whose head comes after it', async () => {
  await runImp('policy', box, 'box', '--allow', 'example.com,example.org');

  // the broker on the guest's gateway (IMP_BROKER_PORT's default; the
  // broker's variables reach only an imp with a grant); a held tunnel that
  // writes until it ends, and one that sends its head after the change
  const route = await runShellInImp(box, 'ip -4 route show default');

  const gateway = /via (?<ip>[\d.]+)/v.exec(route)?.groups?.['ip'] ?? '';
  const broker = `${gateway} 7081`;
  const head = String.raw`CONNECT example.org:80 HTTP/1.1\r\nHost: example.org:80\r\n\r\n`;

  await runShellInImp(
    box,
    `rm -f /tmp/tun-*; setsid sh -c "(printf '${head}'; while sleep 0.2; do printf x; done) | nc ${broker} > /tmp/tun-held; echo done > /tmp/tun-done" </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held tunnel to open', async () => {
    const opened = await tryInImp(box, 'grep -q " 200 " /tmp/tun-held');

    expect(opened).toBeTrue();
  });

  await runShellInImp(
    box,
    `setsid sh -c "(sleep 4; printf '${head}'; sleep 5) | nc ${broker} > /tmp/tun-late" </dev/null >/dev/null 2>&1 &`,
  );

  // the late connection is open, its head not yet sent
  await Bun.sleep(1000);

  await runImp('policy', box, 'box', '--allow', 'example.com');

  await waitFor('the held tunnel to end', async () => {
    const ended = await tryInImp(box, 'test -f /tmp/tun-done');

    expect(ended).toBeTrue();
  });

  await waitFor('the late head to be refused', async () => {
    const refused = await tryInImp(box, 'grep -q " 403 " /tmp/tun-late');

    expect(refused).toBeTrue();
  });
});

test('none reaches nothing, and open gives it all back', async () => {
  await runImp('policy', box, 'none');

  const shut = [
    await tryGetFromImp(box, 'http://example.com/'),
    await tryDialFromImp(box, OUTSIDE, 443),
  ];

  await runImp('policy', box, 'open');

  const reopened = await tryGetFromImp(box, 'http://example.org/');

  expect(shut).toEqual([false, false]);
  expect(reopened).toBeTrue();
});

// A netns in the dev container that the suite owns, behind a veth: a 10/8
// and a link-local address, whose listener logs each connection. Guests
// reach it through FORWARD, as a private network beside the host.
const LAN = {
  netns: 'e2e-egress-lan',
  private: '10.250.77.1',
  linkLocal: '169.254.77.1',
  port: 8077,
  log: '/tmp/e2e-egress-lan.log',
};

const LAN_LISTENER = `
const { appendFileSync } = require('node:fs');
Bun.listen({
  hostname: '0.0.0.0',
  port: ${String(LAN.port)},
  socket: {
    open: (socket) => {
      appendFileSync('${LAN.log}', socket.localAddress + ' ' + socket.remoteAddress + '\\n');
      socket.write('hello\\n');
    },
    data: () => {},
  },
});
`;

const LAN_SETUP = `
set -e
ip netns del ${LAN.netns} 2>/dev/null || true
ip netns add ${LAN.netns}
ip link add e2elan0 type veth peer name eth0 netns ${LAN.netns}
ip addr add 10.250.77.254/24 dev e2elan0
ip link set e2elan0 up
ip -n ${LAN.netns} addr add ${LAN.private}/24 dev eth0
ip -n ${LAN.netns} addr add ${LAN.linkLocal}/32 dev eth0
ip -n ${LAN.netns} link set eth0 up
ip -n ${LAN.netns} link set lo up
ip -n ${LAN.netns} route add default via 10.250.77.254
ip route add ${LAN.linkLocal}/32 dev e2elan0
: > ${LAN.log}
setsid ip netns exec ${LAN.netns} bun -e "$LISTENER" </dev/null >/dev/null 2>&1 &
`;

async function runLanScript(script: string): Promise<void> {
  const result = await runInContainer(['env', `LISTENER=${LAN_LISTENER}`, 'sh', '-c', script]);

  if (result.exitCode !== 0) {
    throw new Error(`the lan netns: ${result.stderr}`);
  }
}

// the connections each lan listener took, by the address dialled
async function countLanConnections(): Promise<Readonly<Record<string, number>>> {
  const result = await runInContainer(['cat', LAN.log]);

  const counts: Record<string, number> = { [LAN.private]: 0, [LAN.linkLocal]: 0 };

  for (const line of result.stdout.split('\n')) {
    const [local = ''] = line.split(' ');

    if (local in counts) {
      counts[local] = (counts[local] ?? 0) + 1;
    }
  }

  return counts;
}

beforeAll(async () => {
  await runLanScript(LAN_SETUP);

  // the container reaches both listeners itself: they are up
  await waitFor('the lan listeners', async () => {
    for (const address of [LAN.private, LAN.linkLocal]) {
      const probe = await runInContainer([
        'bash',
        '-c',
        `exec 3<>/dev/tcp/${address}/${String(LAN.port)}`,
      ]);

      expect(probe.exitCode).toBe(0);
    }
  });

  await createImp(pub, '--image', TINY, '--memory', '256', '--policy', 'public');
  await holdImp(pub);
}, 600_000);

afterAll(async () => {
  await runInContainer([
    'sh',
    '-c',
    `ip netns pids ${LAN.netns} | xargs -r kill; ip netns del ${LAN.netns}`,
  ]);
});

interface Dial {
  readonly isConnected: boolean;
  readonly ms: number;
  readonly error: string;
}

// A TCP connection from the guest by nc, timed by /proc/uptime's hundredths;
// a failure is tried again with wget, which names it (nc fails in silence).
// A refusal is a reset, at once, where a drop would take all 5 s of -w.
async function runTimedDial(name: string, target: string, port: number): Promise<Dial> {
  const script = [
    'rm -f /tmp/dial-err',
    "s=$(cut -d ' ' -f 1 /proc/uptime | tr -d .)",
    `echo | nc -w 5 ${target} ${String(port)} >/dev/null 2>&1`,
    'rc=$?',
    "e=$(cut -d ' ' -f 1 /proc/uptime | tr -d .)",
    `[ $rc = 0 ] || wget -q -T 5 -O /dev/null http://${target}:${String(port)}/ 2>/tmp/dial-err`,
    String.raw`echo "$rc $(( (e - s) * 10 )) $(head -c 200 /tmp/dial-err | tr -s "\n" " ")"`,
  ].join('; ');

  const out = await runShellInImp(name, script);

  const [rc = '', ms = '', ...words] = out.trim().split(' ');

  return { isConnected: rc === '0', ms: Number(ms), error: words.join(' ') };
}

test('the open imp reaches each private listener, as a control', async () => {
  const before = await countLanConnections();

  const gateway = held.accepted;

  const dials = [
    await runTimedDial(open, LAN.private, LAN.port),
    await runTimedDial(open, host.gateway, host.port),
  ];

  const after = await countLanConnections();

  expect(dials.map((dial) => dial.isConnected)).toEqual([true, true]);
  expect(after[LAN.private]).toBe((before[LAN.private] ?? 0) + 1);
  expect(held.accepted).toBe(gateway + 1);
});

test('a public imp is refused the bridge gateway, 10/8 and link-local at once, with a reset', async () => {
  const before = await countLanConnections();

  const gateway = held.accepted;

  const targets = [
    [host.gateway, host.port],
    [LAN.private, LAN.port],
    [LAN.linkLocal, LAN.port],
    ['169.254.169.254', 80],
  ] as const;

  const dials = [];

  for (const [target, port] of targets) {
    dials.push({ target, ...(await runTimedDial(pub, target, port)) });
  }

  const after = await countLanConnections();

  for (const dial of dials) {
    expect({ target: dial.target, isConnected: dial.isConnected }).toEqual({
      target: dial.target,
      isConnected: false,
    });

    expect(dial.error).toContain('Connection refused');
    expect(dial.ms).toBeLessThan(1000);
  }

  writeMetric('egressPublicRefusalMs', Math.max(...dials.map((dial) => dial.ms)));

  // no listener saw a connection: the firewall refused it, no dead listener
  expect(after).toEqual(before);
  expect(held.accepted).toBe(gateway);
});

test('a public imp is refused the tailnet address, when the host has one', async () => {
  const info = await readInfo();

  const ip = info.tailscale.ip;

  if (ip === null) {
    console.log('    no tailnet address here; skipped');

    return;
  }

  const dial = await runTimedDial(pub, ip, 7070);

  expect(dial.isConnected).toBeFalse();
});

test('a public imp fetches from the internet, and its DNS hides inside answers', async () => {
  const fetched = await tryGetFromImp(pub, 'http://example.com/');

  // a public name that resolves into 10/8 (sslip.io answers with the
  // address the name spells): the open imp asks a public resolver itself and
  // gets it; the public imp's query goes to impd, which removes it
  const name = '10-250-77-1.sslip.io';

  const openAnswer = await runShellInImp(open, `nslookup ${name} 8.8.8.8 || true`);
  const publicAnswer = await runShellInImp(pub, `nslookup ${name} 8.8.8.8 || true`);

  expect(fetched).toBeTrue();
  expect(openAnswer).toContain(LAN.private);
  expect(publicAnswer).not.toContain(LAN.private);
});

test('the controls still reach the listeners after the public refusals', async () => {
  const dials = [
    await runTimedDial(open, LAN.private, LAN.port),
    await runTimedDial(open, host.gateway, host.port),
  ];

  expect(dials.map((dial) => dial.isConnected)).toEqual([true, true]);
});
