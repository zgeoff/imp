import { expect, test } from 'bun:test';
import { findImpByName, listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { BUILDER_IMAGE, createBuilders } from './builder-imps';
import { createFakeGuest } from './fake-guest';

// failedDestroys: how many destroyImp calls fail; the ones after wait for
// releaseDestroys
async function setupBuilderTest(failedDestroys = 0) {
  const ctx = await setupImpTest({ env: { IMP_BUILD_MEMORY_MIB: '512', IMP_BUILD_DISK_GIB: '4' } });

  await ctx.createTestImage('base');

  // the first `docker info` finds the engine still starting
  let infos = 0;

  const guest = createFakeGuest((run) => {
    if (run.argv[1] === 'info') {
      infos += 1;

      return infos === 1 ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : {};
    }

    return { stdout: 'ok' };
  });

  const ensured: string[] = [];
  const logs: string[] = [];
  const destroys = { failed: 0 };
  const released = Promise.withResolvers<void>();

  if (failedDestroys === 0) {
    released.resolve();
  }

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.imps,
      openBuilderExec: (_name, request) => guest.open(request),
      destroyImp: async (name) => {
        if (destroys.failed < failedDestroys) {
          destroys.failed += 1;
          throw new Error('the jailer did not stop');
        }

        await released.promise;

        await ctx.imps.destroyImp(name);
      },
    },
    ensureImage: async () => {
      ensured.push(BUILDER_IMAGE);

      await ctx.createTestImage(BUILDER_IMAGE);
    },
    log: (message) => {
      logs.push(message);
    },
    removeRetryMs: 10,
  });

  return Object.assign(ctx, { builders, guest, ensured, logs, releaseDestroys: released.resolve });
}

test('a build gets a public builder of the build size, which goes when the build ends', async () => {
  await using ctx = await setupBuilderTest();

  const seen = await ctx.builders.withBuilder(new AbortController().signal, async (exec) => {
    const imps = await listImps(ctx.db);

    const builder = imps.find((imp) => imp.kind === 'builder');

    const ran = await exec(['echo'], { signal: new AbortController().signal });

    return { builder, ran: ran.stdout };
  });

  expect(seen.builder).toMatchObject({
    kind: 'builder',
    memoryMib: 512,
    diskBytes: 4 * 1024 ** 3,
  });

  expect(seen.builder?.name).toMatch(/^imp-build-[a-z2-9]{8}$/v);
  expect(seen.ran).toBe('ok');
  expect(ctx.ensured).toEqual([BUILDER_IMAGE]);

  expect(ctx.guest.runs.map((run) => run.argv.join(' '))).toEqual([
    'docker info --format {{.ServerVersion}}',
    'docker info --format {{.ServerVersion}}',
    'echo',
  ]);

  const policy = await ctx.egress.readPolicy(seen.builder?.name ?? '').catch(() => null);

  expect(policy).toBeNull();

  const after = await listImps(ctx.db);

  expect(after).toEqual([]);
});

test('a failed build leaves no builder, and a stopped impd’s builders go at the next start', async () => {
  await using ctx = await setupBuilderTest();

  const failure = await ctx.builders
    .withBuilder(new AbortController().signal, async (exec) => {
      const [builder] = await listImps(ctx.db);
      const policy = await ctx.egress.readPolicy(builder?.name ?? '');

      expect(policy).toEqual({
        mode: 'public',
        allow: [],
      });

      await exec(['true'], { signal: new AbortController().signal });

      throw new Error('the build failed');
    })
    .catch((error: unknown) => error);

  expect(String(failure)).toContain('the build failed');

  const after = await listImps(ctx.db);

  expect(after).toEqual([]);

  await ctx.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });
  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.builders.removeLeftovers();

  const left = await listImps(ctx.db);

  expect(left.map((imp) => imp.name)).toEqual(['dev']);
});

// the builders left, once impd's retries have had their chance
async function readBuildersAfterRetries(db: ImpDatabase) {
  for (let tries = 0; tries < 50; tries += 1) {
    const imps = await listImps(db);

    if (imps.length === 0) {
      return imps;
    }

    await Bun.sleep(10);
  }

  return listImps(db);
}

test('a builder that survives its removal fails its build, logs, and goes on a retry', async () => {
  await using ctx = await setupBuilderTest(1);

  const failure = await ctx.builders
    .withBuilder(new AbortController().signal, async (exec) => {
      const built = await exec(['true'], { signal: new AbortController().signal });

      return built.stdout;
    })
    .catch((error: unknown) => error);

  expect(String(failure)).toMatch(/the builder imp-build-[a-z2-9]{8} could not be removed/v);

  const survivors = await listImps(ctx.db);

  expect(survivors.map((imp) => imp.kind)).toEqual(['builder']);

  ctx.releaseDestroys();

  const left = await readBuildersAfterRetries(ctx.db);

  expect(left).toEqual([]);
  expect(ctx.logs.some((line) => line.includes('ERROR: builder imp-build-'))).toBe(true);
  expect(ctx.logs.some((line) => line.startsWith('impd: image build: removed builder'))).toBe(true);
});

test('a leftover builder that survives its removal at start goes on a retry', async () => {
  await using ctx = await setupBuilderTest(2);

  await ctx.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });
  await ctx.builders.removeLeftovers();

  const survivors = await listImps(ctx.db);

  expect(survivors.map((imp) => imp.name)).toEqual(['imp-build-left']);

  ctx.releaseDestroys();

  const left = await readBuildersAfterRetries(ctx.db);

  expect(left).toEqual([]);
  expect(ctx.logs.filter((line) => line.includes('ERROR: builder imp-build-left'))).toHaveLength(2);
});

test('a builder refuses every stream and every change but rm, and lists only when asked', async () => {
  await using ctx = await setupBuilderTest();

  const app = buildTestApp(ctx, ctx);

  await ctx.imps.createImp({
    name: 'imp-build-x',
    image: 'base',
    kind: 'builder',
    policy: { mode: 'public', allow: [] },
  });

  await ctx.imps.createImp({ name: 'dev', image: 'base' });

  const refusals = await Promise.all([
    readRejection(ctx.imps.openExec('imp-build-x', { argv: ['sh'], tty: false })),
    readRejection(
      app.client.imps.setPolicy({ name: 'imp-build-x', policy: { mode: 'open', allow: [] } }),
    ),
    readRejection(app.client.exec.ticket({ name: 'imp-build-x' })),
    readRejection(app.client.imps.fork({ source: 'imp-build-x', name: 'copy' })),
    readRejection(app.client.imps.stop({ name: 'imp-build-x' })),
    readRejection(app.client.checkpoints.create({ name: 'imp-build-x' })),
    readRejection(app.client.images.add({ imp: 'imp-build-x', name: 'tpl' })),
    readRejection(app.client.moves.prepare({ name: 'imp-build-x' })),
  ]);

  for (const refusal of refusals) {
    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(String(refusal)).toContain('imp-build-x is an image builder');
  }

  const listed = await app.client.imps.list();
  const all = await app.client.imps.list({ builders: true });
  const info = await app.client.imps.get({ name: 'imp-build-x' });

  expect(listed.map((imp) => imp.name)).toEqual(['dev']);

  expect(all.map((imp) => [imp.name, imp.kind])).toEqual([
    ['dev', 'user'],
    ['imp-build-x', 'builder'],
  ]);

  expect(info.kind).toBe('builder');

  await app.client.imps.destroy({ name: 'imp-build-x' });

  const gone = await findImpByName(ctx.db, 'imp-build-x');

  expect(gone).toBeUndefined();
});

test('no client names an image imp-builder, which is impd’s', async () => {
  await using ctx = await setupBuilderTest();

  const app = buildTestApp(ctx, ctx);

  await ctx.imps.createImp({ name: 'dev', image: 'base' });

  const signal = new AbortController().signal;

  const building = ctx.images.buildImageFromContext(
    '/nowhere.tar',
    BUILDER_IMAGE,
    undefined,
    signal,
  );

  const refusals = await Promise.all([
    readRejection(app.client.images.add({ ref: 'busybox:latest', name: BUILDER_IMAGE })),
    readRejection(app.client.images.add({ imp: 'dev', name: BUILDER_IMAGE })),
    readRejection(building),
  ]);

  for (const refusal of refusals) {
    expect(String(refusal)).toContain(`the image name ${BUILDER_IMAGE} is impd's`);
  }
});
