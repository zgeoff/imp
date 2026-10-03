import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { findImageByName } from '../db/images';
import { openDatabase } from '../db/open-database';
import { buildImagePaths } from '../storage/data-layout';
import { createStorageGate } from '../storage/storage-gate';
import { createXfsBackend } from '../storage/xfs-backend';
import type { Builders } from './builder-imps';
import { createFakeGuest } from './fake-guest';
import type { FakeAnswer, FakeRun } from './fake-guest';
import { createGuestExec } from './guest-exec';
import { PIN_INSPECT_FORMAT } from './image-pin';
import { createImageService } from './image-service';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imp-isolated-build-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'd'.repeat(64);
const CONFIG = '{"Cmd":["/bin/sh"],"Env":["PATH=/bin"]}';

// a tar of a directory holding these files
function buildTar(files: Readonly<Record<string, string>>): Uint8Array {
  const tree = join(dir, `tree-${Bun.randomUUIDv7()}`);

  mkdirSync(tree);

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tree, name), content);
  }

  return Bun.spawnSync(['tar', '-C', tree, '-c', ...Object.keys(files)]).stdout;
}

// A builder's engine on amd64 that has base.test/a:1 and the frontend, and
// builds whatever it gets; the Dockerfile each build got
function createBuilderAnswer(onBuild: (dockerfile: string) => void, exported: Uint8Array) {
  return async (run: FakeRun): Promise<FakeAnswer> => {
    const argv = run.argv.slice(1).join(' ');

    if (argv.startsWith('version ')) {
      return { stdout: '"linux" "x86_64"\n' };
    }

    if (argv === `image inspect --format ${PIN_INSPECT_FORMAT} base.test/a:1`) {
      const inspect = {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/a@${DIGEST_A}`],
        Os: 'linux',
        Architecture: 'amd64',
        Config: {},
      };

      return { stdout: JSON.stringify(inspect) };
    }

    if (argv.startsWith('image inspect --format {{.Id}} docker/dockerfile')) {
      return { stdout: `sha256:${'f'.repeat(64)}\n` };
    }

    if (argv.startsWith('build ')) {
      const context = await run.readStdin();

      const dockerfile = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], { stdin: context });

      onBuild(new TextDecoder().decode(dockerfile.stdout));

      return { stderr: '#1 DONE\n' };
    }

    if (argv === 'image inspect --format {{json .Config}} imp-build:latest') {
      return { stdout: CONFIG };
    }

    if (argv === 'create imp-build:latest /bin/true') {
      return { stdout: `${CONTAINER_ID}\n` };
    }

    if (argv === `export ${CONTAINER_ID}`) {
      return { stdout: [exported] };
    }

    return { code: 1, stderr: `the fake builder has no ${argv}` };
  };
}

async function setupIsolatedBuild() {
  const dataDir = join(dir, 'data');

  mkdirSync(dataDir);

  const db = await openDatabase(':memory:');

  const builtDockerfiles: string[] = [];
  const exported = buildTar({ hello: 'from the builder\n' });

  const guest = createFakeGuest(
    createBuilderAnswer((dockerfile) => {
      builtDockerfiles.push(dockerfile);
    }, exported),
  );

  const boots: string[] = [];

  const builders: Builders = {
    withBuilder: (_signal, run) => {
      boots.push('builder');

      return run(createGuestExec(guest.open));
    },
    removeLeftovers: () => Promise.resolve(),
  };

  // a host docker that logs every call: an isolated build makes none
  const bin = join(dir, 'bin');
  const hostLog = join(dir, 'host-docker.log');

  mkdirSync(bin);

  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >>'${hostLog}'\nexit 1\n`, {
    mode: 0o755,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: dataDir }),
    db,
    storage: createXfsBackend({ dataDir }),
    storageGate: createStorageGate(),
    diskBudget: { withRoom: (_bytes, task) => task() },
    readBuilders: () => builders,
    log: () => {},
  });

  const runBuild = async (dockerfile: string) => {
    const tarPath = join(dir, `context-${Bun.randomUUIDv7()}.tar`);

    writeFileSync(tarPath, buildTar({ Dockerfile: dockerfile }));

    const savedPath = process.env['PATH'];

    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;

    try {
      return await images.buildImageFromContext(
        tarPath,
        'web',
        undefined,
        new AbortController().signal,
      );
    } finally {
      process.env['PATH'] = savedPath;
    }
  };

  const readHostCalls = () => (existsSync(hostLog) ? readFileSync(hostLog, 'utf8') : '');

  return { db, dataDir, guest, builtDockerfiles, exported, boots, runBuild, readHostCalls };
}

test('an isolated build pins, builds and exports in its builder, and the host engine sees none of it', async () => {
  const ctx = await setupIsolatedBuild();
  const image = await ctx.runBuild('FROM base.test/a:1\nRUN true\n');

  // the digest's own form: no Docker image ID is one
  expect(image).toMatchObject({ name: 'web', ref: 'imp/web:latest' });
  expect(image.digest).toMatch(/^imp-build-[a-f0-9]{64}$/v);

  const saved = await findImageByName(ctx.db, 'web');

  expect(saved).toMatchObject({ digest: image.digest });
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBe(true);
  expect(ctx.builtDockerfiles).toEqual([`FROM base.test/a@${DIGEST_A}\nRUN true\n`]);
  expect(ctx.readHostCalls()).toBe('');

  expect(ctx.guest.runs.map((run) => run.argv.slice(1, 3).join(' '))).toEqual([
    'version --format',
    'image inspect',
    'image inspect',
    'build --progress=plain',
    'image inspect',
    'create imp-build:latest',
    `export ${CONTAINER_ID}`,
  ]);
});

test('a Dockerfile the input guard refuses boots no builder', async () => {
  const ctx = await setupIsolatedBuild();

  const failure = await ctx
    .runBuild('FROM base.test/a:1\nADD https://example.com/x /x\n')
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(ctx.boots).toEqual([]);
  expect(ctx.guest.runs).toEqual([]);
});
