import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as dnsPacket from 'dns-packet';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
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

// an address no allow-list here names, and no answer adds
const OUTSIDE = '9.9.9.9';

// a server on this machine, which guests reach on the dev container's
// default gateway: a private address, held open for the flush test
const held = { received: 0 };
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
