import { expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { runImp, runInImp, runShellInImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { readImpdLogTail, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// Boot templates (docs/architecture/boot-templates.md): every restored imp
// must be its own machine. The e2e-ws image carries isn-probe, which prints
// the secret part of the TCP ISN.

const prefix = setupSuite('boot-templates');
const WS = resolveImageName('e2e-ws');

// a shape no other suite boots, so this suite sees its own template made
const MEMORY_MIB = '288';
const TEMPLATE_MAC = '06:00:a9:fe:ff:fe';
const GIB_KIB = 1024 * 1024;
const first = `${prefix}a`;
const second = `${prefix}b`;
const third = `${prefix}c`;

// two guests that share the kernel's net_secret print values within a few
// hundred of each other; isn-probe's own noise is well under this
const SHARED_SECRET_SPAN = 100_000;

function createShaped(name: string, ...args: readonly string[]): Promise<string> {
  return createImp(name, '--image', WS, '--memory', MEMORY_MIB, '--cpus', '1', ...args);
}

// the distance between two u32 values, around the wrap
function findSpan(a: number, b: number): number {
  const span = Math.abs(a - b);

  return Math.min(span, 2 ** 32 - span);
}

async function readIsnSecret(name: string): Promise<number> {
  const stdout = await runInImp(name, 'isn-probe');

  return Number(stdout.trim());
}

async function readMac(name: string): Promise<string> {
  const stdout = await runInImp(name, 'cat', '/sys/class/net/eth0/address');

  return stdout.trim();
}

test('the first boot of a shape makes its template; later boots restore it', async () => {
  await createShaped(first);

  await waitFor(
    'the boot template of the shape',
    async () => {
      const found = await runInContainer([
        'sh',
        '-c',
        `grep -l '"memoryMib": ${MEMORY_MIB}' /var/lib/imp/templates/*/meta.json`,
      ]);

      expect(found.exitCode).toBe(0);
    },
    { timeoutMs: 120_000 },
  );

  await createShaped(second, '--disk', '6g');
  await createShaped(third);

  const log = await readImpdLogTail(400);

  expect(log).toContain(`${second}: restored boot template`);
  expect(log).toContain(`${third}: restored boot template`);
});

test('a restored imp has its own name, MAC, address and disk size', async () => {
  const hostname = await runInImp(second, 'hostname');

  const macs = [await readMac(second), await readMac(third)];

  expect(hostname.trim()).toBe(second);
  expect(macs[0]).not.toBe(TEMPLATE_MAC);
  expect(macs[1]).not.toBe(TEMPLATE_MAC);
  expect(macs[0]).not.toBe(macs[1]);

  const df = await runInImp(second, 'df', '-k', '/');

  const sizeKib = Number(df.trim().split('\n').at(-1)?.split(/\s+/)[1]);

  // ext4 keeps some of the 6 GiB for itself
  expect(sizeKib / GIB_KIB).toBeGreaterThan(5.8);

  // the claim's gateway is the default route
  const route = await runShellInImp(second, 'ip -4 route show default');

  expect(route).toContain('via');
});

test('each restored imp keys TCP with its own secret', async () => {
  const secrets = {
    first: await readIsnSecret(first),
    second: await readIsnSecret(second),
    third: await readIsnSecret(third),
  };

  // the probe itself: one guest, twice, gives the same secret
  const again = await readIsnSecret(second);

  expect(findSpan(secrets.second, again)).toBeLessThan(SHARED_SECRET_SPAN);
  expect(findSpan(secrets.second, secrets.third)).toBeGreaterThan(SHARED_SECRET_SPAN);
  expect(findSpan(secrets.first, secrets.second)).toBeGreaterThan(SHARED_SECRET_SPAN);
  expect(findSpan(secrets.first, secrets.third)).toBeGreaterThan(SHARED_SECRET_SPAN);
});

test('a restored imp sleeps and wakes like any other', async () => {
  await runInImp(second, 'sh', '-c', 'echo kept > /root/marker');
  await runImp('sleep', second);

  const marker = await runInImp(second, 'cat', '/root/marker');

  expect(marker.trim()).toBe('kept');
});
