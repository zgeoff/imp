import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskBudget } from '../storage/disk-budget';
import { buildMockTemplateBuildPlan } from './build-mock-template-build-plan';
import { buildStubTemplateVm } from './build-stub-template-vm';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-template-vm-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // a host with 1 TiB free, so no build meets this machine's disk
  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }) },
    reserveBytes: null,
    log: () => {},
  });

  return { dir, diskBudget };
}

test('it writes the snapshot files where the plan names them', async () => {
  const ctx = await setupTest();

  const vm = buildStubTemplateVm(ctx.diskBudget);
  const plan = buildMockTemplateBuildPlan({ workDir: join(ctx.dir, '.build-a') });

  await vm.buildVm(plan);

  const vmstate = await readFile(join(ctx.dir, '.build-a', 'snapshot', 'vmstate'), 'utf8');
  const mem = await readFile(join(ctx.dir, '.build-a', 'snapshot', 'mem'), 'utf8');

  expect(vmstate).toBe('vmstate');
  expect(mem).toBe('mem');
});

test('it records each plan it boots, in order', async () => {
  const ctx = await setupTest();

  const vm = buildStubTemplateVm(ctx.diskBudget);
  const first = buildMockTemplateBuildPlan({ workDir: join(ctx.dir, '.build-a') });
  const second = buildMockTemplateBuildPlan({ workDir: join(ctx.dir, '.build-b') });

  await vm.buildVm(first);
  await vm.buildVm(second);

  expect(vm.builds).toStrictEqual([first, second]);
});

test('it records the disk room the budget holds while a build runs', async () => {
  const ctx = await setupTest();

  const vm = buildStubTemplateVm(ctx.diskBudget);
  const plan = buildMockTemplateBuildPlan({ workDir: join(ctx.dir, '.build-a') });

  await ctx.diskBudget.withRoom(64 * 1024 ** 2, () => vm.buildVm(plan));
  await vm.buildVm(plan);

  expect(vm.pendingAtBuild).toStrictEqual([64 * 1024 ** 2, 0]);
});
