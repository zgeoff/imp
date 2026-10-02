import { expect, test } from 'bun:test';
import { openSessionSocket, requireOutput } from '../lib/exec-socket';
import type { SessionOutput } from '../lib/exec-socket';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runImp, runInImp, runShellInImp } from '../lib/imp-cli';
import { createImp, removeImps } from '../lib/imps';
import { readImpdLogTail, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

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
const spare = `${prefix}x`;

// two guests that share the kernel's net_secret print values within a few
// hundred of each other; isn-probe's own noise is well under this
const SHARED_SECRET_SPAN = 100_000;

// creates timed one after another, each removed before the next
const TIMED_CREATES = 10;

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

// a session's output identity: its boot, and the imp's last cold boots
async function readSessionOutput(name: string): Promise<SessionOutput> {
  const opened = await openSessionSocket({
    type: 'start',
    name,
    session: 'boot',
    argv: ['sleep', 'infinity'],
    tty: true,
  });

  const output = requireOutput(opened);

  opened.close();

  return output;
}

async function readMac(name: string): Promise<string> {
  const stdout = await runInImp(name, 'cat', '/sys/class/net/eth0/address');

  return stdout.trim();
}

test('the second boot of a shape makes its template; later boots restore it', async () => {
  await createShaped(first);

  // the second miss of the key starts the build
  await createShaped(spare);
  await removeImps(spare);

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

  // the guest's own word that the claim reseeded its CRNG
  const found = await requireImp(second);

  const consoleLog = await runInContainer([
    'cat',
    `/var/lib/imp/imps/${found.id}/run/firecracker.log`,
  ]);

  expect(consoleLog.stdout).toContain('boot: claim: crng reseeded from a 64-byte seed');
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

test('each restored boot names itself, so its cold boot is recorded', async () => {
  const before = await readSessionOutput(second);
  const other = await readSessionOutput(third);

  await runImp('stop', second);
  await runImp('start', second);

  const after = await readSessionOutput(second);
  const log = await readImpdLogTail(400);

  // the start restored the template again, not the kernel
  expect(log.split(`${second}: restored boot template`).length - 1).toBeGreaterThanOrEqual(2);
  expect(other.bootId).not.toBe(before.bootId);
  expect(after.bootId).not.toBe(before.bootId);

  expect(after.coldBoots.map((boot) => boot.bootId).slice(0, 2)).toEqual([
    after.bootId,
    before.bootId,
  ]);
});

test('a restored imp sleeps and wakes like any other', async () => {
  await runInImp(second, 'sh', '-c', 'echo kept > /root/marker');
  await runImp('sleep', second);

  const marker = await runInImp(second, 'cat', '/root/marker');

  expect(marker.trim()).toBe('kept');
});

// `name=12ms` pairs from the impd log line that names the imp and `what`
function readLoggedSteps(log: string, name: string, what: string): Record<string, number> {
  const line = log.split('\n').findLast((candidate) => candidate.includes(`${name}: ${what}`));
  const steps: Record<string, number> = {};

  for (const match of line?.matchAll(/(?<step>\w+)=(?<ms>\d+)ms/g) ?? []) {
    steps[match.groups?.['step'] ?? ''] = Number(match.groups?.['ms']);
  }

  const total = /created in (?<ms>\d+)ms/.exec(line ?? '')?.groups?.['ms'];

  return total === undefined ? steps : { ...steps, total: Number(total) };
}

function pickPercentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

test('imp new from a template, timed: the wall time and its spans', async () => {
  const walls: number[] = [];
  const spans: Record<string, number[]> = {};

  for (let index = 0; index < TIMED_CREATES; index += 1) {
    const name = `${prefix}t${String(index)}`;
    const started = performance.now();

    await createShaped(name);

    walls.push(performance.now() - started);

    const log = await readImpdLogTail(50);

    const created = readLoggedSteps(log, name, 'created in');
    const restored = readLoggedSteps(log, name, 'restored boot template');
    const vmMs = Object.values(restored).reduce((sum, ms) => sum + ms, 0);

    expect(restored['agent']).toBeNumber();

    // the CLI's process and the API round trip, and impd's write-up after the VM
    const found = {
      ...restored,
      ...created,
      cli: Math.round((walls.at(-1) ?? 0) - (created['total'] ?? 0)),
      finish: (created['boot'] ?? 0) - vmMs,
    };

    for (const [step, ms] of Object.entries(found)) {
      spans[step] = [...(spans[step] ?? []), ms];
    }

    await removeImps(name);
  }

  const medians = Object.fromEntries(
    Object.entries(spans).map(([step, values]) => [step, pickPercentile(values, 0.5)]),
  );

  writeMetric('bootTemplateNewMs', {
    p50: Math.round(pickPercentile(walls, 0.5)),
    p95: Math.round(pickPercentile(walls, 0.95)),
    n: walls.length,
  });

  writeMetric('bootTemplateNewSpansP50Ms', medians);
});
