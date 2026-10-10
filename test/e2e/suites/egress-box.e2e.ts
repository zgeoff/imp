import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { buildTcpQueryOctal, parseTcpReplyHex } from '../lib/dns-probe';
import { resolveImageName } from '../lib/fixtures';
import { tryDialFromImp, tryGetFromImp, tryInImp } from '../lib/guest-probe';
import { startHeldListener } from '../lib/held-listener';
import { createInstanceClient, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { readContainerGateway } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Egress policies in real guests (docs/architecture/networking.md#egress):
// impd's nft table, its resolver, and the nat redirect of port 53. The
// public hosts are example.com and Quad9; this machine is the private one.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const gateway = await readContainerGateway();

  return { prefix: readSuitePrefix('egress'), stack, client, gateway };
}

test('it lets an open imp reach the internet and the private gateway, and no imp the metadata service', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}open`;
  const listener = startHeldListener(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const reached = [
    await tryGetFromImp(name, 'http://example.com/'),
    await tryGetFromImp(name, 'http://example.org/'),
    await tryDialFromImp(name, ctx.gateway, listener.port),
  ];

  const metadata = await tryDialFromImp(name, '169.254.169.254', 80);

  expect(reached).toStrictEqual([true, true, true]);
  expect(metadata).toBeFalse();
});

test('it lets a box imp reach its list, and nothing else', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}box`;
  const listener = startHeldListener(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const started = performance.now();

  const allowed = await tryGetFromImp(name, 'http://example.com/');

  writeMetric('egressFirstFetchMs', Math.round(performance.now() - started));

  // 9.9.9.9: an address no list here names, and no answer adds
  const denied = [
    await tryGetFromImp(name, 'http://example.org/'),
    await tryDialFromImp(name, '9.9.9.9', 443),
    await tryDialFromImp(name, ctx.gateway, listener.port),
  ];

  expect(allowed).toBeTrue();
  expect(denied).toStrictEqual([false, false, false]);
});

test('it answers a refused name with REFUSED and EDE 18, whichever resolver the guest asks', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}dns`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  // over TCP, which busybox's nc speaks: a length, then the message
  const hex = await runShellInImp(
    name,
    `printf '${buildTcpQueryOctal('example.org')}' | nc -w 3 8.8.8.8 53 | od -An -tx1 -v`,
  );

  const parsed = parseTcpReplyHex(hex);

  expect(parsed.reply).toMatchObject({ rcode: 'REFUSED', answers: [] });
  expect(parsed.lastOption).toStrictEqual([15, 18]);
});

test('it drops a guest that sends from another address of its /30', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}spoof`;
  const listener = startHeldListener(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    `example.com,${ctx.gateway}/32`,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const row = await requireImp(name);

  const octets = row.ip.split('.').map(Number);

  // the /30's network address, which the tap's reverse-path check passes
  const other = [...octets.slice(0, 3), (octets[3] ?? 0) - 2].join('.');

  await runShellInImp(name, `ip addr add ${other}/32 dev eth0`);

  const fromGuest = await tryDialFromImp(name, ctx.gateway, listener.port);
  const fromOther = await tryDialFromImp(name, ctx.gateway, listener.port, other);

  expect([fromGuest, fromOther]).toStrictEqual([true, false]);
});

test('it opens a private address only by an explicit CIDR, and cuts its flow under a tighter policy', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cidr`;
  const listener = startHeldListener(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    `example.com,${ctx.gateway}/32`,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  // a flow from the guest that writes every 200 ms until something ends it
  await runShellInImp(
    name,
    `rm -f /tmp/nc-done; setsid sh -c '(while sleep 0.2; do echo x; done | nc ${ctx.gateway} ${String(listener.port)}; echo done > /tmp/nc-done)' </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held flow to carry data', () => {
    if (listener.readReceived() <= 10) {
      throw new Error(`${String(listener.readReceived())} bytes so far`);
    }
  });

  await runImp('policy', name, 'box', '--allow', 'example.com');

  const ended = await waitFor('the guest to see its flow end', async () => {
    const done = await tryInImp(name, 'test -f /tmp/nc-done');

    if (!done) {
      throw new Error('the flow is still open');
    }

    return done;
  });

  const policy = await runImp('policy', name);

  expect(ended).toBeTrue();
  expect(policy.trim()).toBe('box: example.com');
});

test('it ends the broker tunnels a tighter policy denies, even one whose head comes after it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}tun`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com,example.org',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  // the broker on the guest's gateway (IMP_BROKER_PORT's default; the
  // broker's variables reach only an imp with a grant)
  const route = await runShellInImp(name, 'ip -4 route show default');

  const gateway = /via (?<ip>[\d.]+)/v.exec(route)?.groups?.['ip'] ?? '';
  const broker = `${gateway} 7081`;
  const head = String.raw`CONNECT example.org:80 HTTP/1.1\r\nHost: example.org:80\r\n\r\n`;

  // A held tunnel that writes a header with no end until something ends it:
  // garbage instead would get a 400 from example.org, which closes it first.
  const hold = String.raw`GET / HTTP/1.1\r\nHost: example.org\r\nX-Hold: `;

  await runShellInImp(
    name,
    `rm -f /tmp/tun-*; setsid sh -c "(printf '${head}'; printf '${hold}'; while sleep 0.2; do printf x; done) | nc ${broker} > /tmp/tun-held; echo done > /tmp/tun-done" </dev/null >/dev/null 2>&1 &`,
  );

  await waitFor('the held tunnel to open', async () => {
    const opened = await tryInImp(name, 'grep -q " 200 " /tmp/tun-held');

    if (!opened) {
      throw new Error('no 200 yet');
    }
  });

  // one that connects now and sends its head 4 s later, after the change
  await runShellInImp(
    name,
    `setsid sh -c "(sleep 4; printf '${head}'; sleep 5) | nc ${broker} > /tmp/tun-late" </dev/null >/dev/null 2>&1 &`,
  );

  // both connections established to the broker's port, 7081 (1BA9): the
  // held one still open, and the late one open with its head not yet sent
  await waitFor('the late connection to open beside the held one', async () => {
    const count = await runShellInImp(
      name,
      `awk '$3 ~ /:1BA9$/ && $4 == "01"' /proc/net/tcp | wc -l`,
    );

    if (Number(count) < 2) {
      throw new Error(`${count.trim()} connections to the broker`);
    }
  });

  await runImp('policy', name, 'box', '--allow', 'example.com');

  const ended = await waitFor('the held tunnel to end', async () => {
    const done = await tryInImp(name, 'test -f /tmp/tun-done');

    if (!done) {
      throw new Error('the held tunnel is still open');
    }

    return done;
  });

  const refused = await waitFor('the late head to be refused', async () => {
    const found = await tryInImp(name, 'grep -q " 403 " /tmp/tun-late');

    if (!found) {
      throw new Error('no 403 yet');
    }

    return found;
  });

  expect(ended).toBeTrue();
  expect(refused).toBeTrue();
});

test('it lets a none imp reach nothing, and open gives it all back', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}none`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    'example.com',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await runImp('policy', name, 'none');

  const shut = [
    await tryGetFromImp(name, 'http://example.com/'),
    await tryDialFromImp(name, '9.9.9.9', 443),
  ];

  await runImp('policy', name, 'open');

  const reopened = await tryGetFromImp(name, 'http://example.org/');

  expect(shut).toStrictEqual([false, false]);
  expect(reopened).toBeTrue();
});
