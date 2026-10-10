import { expect, onTestFinished, test } from 'bun:test';
import {
  readIsnSecret,
  readMac,
  readSessionOutput,
  waitForShapeTemplate,
} from '../lib/boot-template-guest';
import { findU32Span, parseLoggedSteps, pickPercentile } from '../lib/boot-template-timing';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, requireImp, runImp, runInImp, runShellInImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { readImpdLogSince, runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// Boot templates (docs/architecture/boot-templates.md): every restored imp
// is its own machine. Each test boots a shape no other suite boots twice, so
// the second boot builds its template unless an earlier test left one.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('boot-templates'), stack, client };
}

test('it makes the template of a shape on its second boot and restores it as imps with their own name, MAC, address, disk and CRNG', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}a`;
  const spare = `${ctx.prefix}x`;
  const second = `${ctx.prefix}b`;
  const third = `${ctx.prefix}c`;

  const started = new Date();

  await runImp('new', first, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(288);
  await runImp('new', second, '--image', image, '--memory', '288', '--cpus', '1', '--disk', '6g');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runImp('new', third, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, third));

  await waitForExec(third);

  const log = await readImpdLogSince(started);
  const row = await requireImp(second);

  const consoleLog = await runInContainer([
    'cat',
    `/var/lib/imp/imps/${row.id}/run/firecracker.log`,
  ]);

  const hostname = await runInImp(second, 'hostname');
  const secondMac = await readMac(second);
  const thirdMac = await readMac(third);
  const df = await runInImp(second, 'df', '-k', '/');
  const route = await runShellInImp(second, 'ip -4 route show default');

  const sizeKib = Number(df.trim().split('\n').at(-1)?.split(/\s+/v)[1]);

  expect(log).toContain(`${second}: restored boot template`);
  expect(log).toContain(`${third}: restored boot template`);

  // the guest's own word that the claim reseeded its CRNG
  expect(consoleLog.stdout).toContain('boot: claim: crng reseeded from a 64-byte seed');
  expect(hostname).toBe(second);

  // the template's own MAC
  expect(secondMac).not.toBe('06:00:a9:fe:ff:fe');
  expect(thirdMac).not.toBe('06:00:a9:fe:ff:fe');
  expect(secondMac).not.toBe(thirdMac);

  // ext4 keeps some of the 6 GiB for itself
  expect(sizeKib / (1024 * 1024)).toBeGreaterThan(5.8);

  // the claim's gateway is the default route
  expect(route).toContain('via');
});

test('it keys TCP with its own secret in each restored imp', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}a`;
  const spare = `${ctx.prefix}x`;
  const second = `${ctx.prefix}b`;
  const third = `${ctx.prefix}c`;

  await runImp('new', first, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(288);
  await runImp('new', second, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runImp('new', third, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, third));

  await waitForExec(third);

  const firstSecret = await readIsnSecret(first);
  const secondSecret = await readIsnSecret(second);
  const thirdSecret = await readIsnSecret(third);

  // the probe itself: one guest, twice, gives the same secret; two guests
  // that share the kernel's net_secret land within a few hundred
  const again = await readIsnSecret(second);

  expect(findU32Span(secondSecret, again)).toBeLessThan(100_000);
  expect(findU32Span(secondSecret, thirdSecret)).toBeGreaterThan(100_000);
  expect(findU32Span(firstSecret, secondSecret)).toBeGreaterThan(100_000);
  expect(findU32Span(firstSecret, thirdSecret)).toBeGreaterThan(100_000);
});

test('it records each restored boot as its own cold boot, again after a restart restores the template', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}a`;
  const spare = `${ctx.prefix}x`;
  const second = `${ctx.prefix}b`;
  const third = `${ctx.prefix}c`;

  await runImp('new', first, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(288);
  await runImp('new', second, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runImp('new', third, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, third));

  await waitForExec(third);

  const before = await readSessionOutput(second);
  const other = await readSessionOutput(third);

  const restarted = new Date();

  await runImp('stop', second);
  await runImp('start', second);
  await waitForExec(second);

  const after = await readSessionOutput(second);
  const log = await readImpdLogSince(restarted);

  // the start restored the template again, not the kernel
  expect(log).toContain(`${second}: restored boot template`);
  expect(other.bootId).not.toBe(before.bootId);
  expect(after.bootId).not.toBe(before.bootId);

  expect(after.coldBoots.map((boot) => boot.bootId).slice(0, 2)).toStrictEqual([
    after.bootId,
    before.bootId,
  ]);
});

test('it sleeps and wakes a restored imp like any other', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}a`;
  const spare = `${ctx.prefix}x`;
  const second = `${ctx.prefix}b`;

  const started = new Date();

  await runImp('new', first, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(288);
  await runImp('new', second, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(second);
  await runShellInImp(second, 'echo kept > /root/marker');
  await runImp('sleep', second);

  const asleep = await requireImp(second);

  // the exec wakes it
  const marker = await runInImp(second, 'cat', '/root/marker');
  const log = await readImpdLogSince(started);

  expect(log).toContain(`${second}: restored boot template`);
  expect(asleep.state).toBe('sleeping');
  expect(marker).toBe('kept');
});

test('it times imp new from a template: the wall time and its spans', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-ws');
  const first = `${ctx.prefix}a`;
  const spare = `${ctx.prefix}x`;
  const walls: number[] = [];
  const spans: Record<string, number[]> = {};

  await runImp('new', first, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await waitForExec(first);
  await runImp('new', spare, '--image', image, '--memory', '288', '--cpus', '1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(288);

  // ten creates, one after another, each removed before the next
  for (let index = 0; index < 10; index += 1) {
    const name = `${ctx.prefix}t${String(index)}`;

    const created = new Date();

    const wallStarted = performance.now();

    await runImp('new', name, '--image', image, '--memory', '288', '--cpus', '1');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    // the wall time runs until the imp takes an exec
    await waitForExec(name);

    walls.push(performance.now() - wallStarted);

    const log = await readImpdLogSince(created);

    const createdSteps = parseLoggedSteps(log, name, 'created in');
    const restoredSteps = parseLoggedSteps(log, name, 'restored boot template');
    const vmMs = Object.values(restoredSteps).reduce((sum, ms) => sum + ms, 0);

    // the CLI's process and the API round trip, and impd's write-up after
    // the VM
    const found = {
      ...restoredSteps,
      ...createdSteps,
      cli: Math.round((walls.at(-1) ?? 0) - (createdSteps['total'] ?? 0)),
      finish: (createdSteps['boot'] ?? 0) - vmMs,
    };

    for (const [step, ms] of Object.entries(found)) {
      spans[step] = [...(spans[step] ?? []), ms];
    }

    await runImp('rm', name);
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

  // every create restored the template: each has the agent's span
  expect(spans['agent']).toHaveLength(10);
});
