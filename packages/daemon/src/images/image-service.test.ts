import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { openDatabase } from '../db/open-database';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { checkBuildQuery } from '../docker-proxy/rules';
import { createStorageGate } from '../storage/storage-gate';
import { createXfsBackend } from '../storage/xfs-backend';
import { createImageService, normalizeDockerfilePath, planRootfs } from './image-service';

// These all fail before any docker command runs, so no docker is needed.
test('it refuses refs and build contexts that docker could read as flags', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: (_bytes, task) => task(),
        withGrowingRoom: (task) => task(() => Promise.resolve()),
      },
      readBuilders: () => null,
      log: () => {},
    });

    for (const ref of ['--help', '-v/:/host', 'ubuntu --privileged', '']) {
      const failure = await images.addImage(ref, 'x').catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
      expect(String(failure)).toContain('invalid image reference');
    }

    const buildFailure = await images
      .buildImage('--file=/etc/passwd', 'x')
      .catch((error: unknown) => error);

    expect(buildFailure).toMatchObject({ code: 'BAD_REQUEST' });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// #173: the docker CLI prints the proxy's message after its own line for a
// create; impd answers BAD_REQUEST with that message, and nothing else of
// the CLI's output reaches the client
test('images.add answers a proxy refusal as BAD_REQUEST, on the pull and on the create', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);
  const bin = join(dataDir, 'fake-bin');
  const refusal = "imp-docker-proxy: registry localhost:5320 is the host's own";
  const stderr = `Unable to find image 'localhost:5320/x:1' locally\nError response from daemon: ${refusal}`;
  const inspect = JSON.stringify([{ Id: `sha256:${'c'.repeat(64)}`, Config: {}, Size: 1 }]);

  mkdirSync(bin);
  writeFileSync(join(dataDir, 'stderr'), stderr);

  // names the proxy refuses (impd refuses a literal localhost itself): impd
  // pulls registry.example/pulled, and creates from registry.example/local
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      'for last; do :; done',
      'case "$1 $last" in',
      `  "image registry.example/local:1") echo '${inspect}' ;;`,
      `  "pull "*|"create "*) cat '${join(dataDir, 'stderr')}' >&2; exit 1 ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );

  try {
    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir, IMP_BUILD_ISOLATION: 'host' }),
      db: await openDatabase(':memory:'),
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: (_bytes, task) => task(),
        withGrowingRoom: (task) => task(() => Promise.resolve()),
      },
      readBuilders: () => null,
      log: () => {},

      // the fake docker first, for these calls only
      dockerEnv: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    });

    for (const ref of ['registry.example/pulled:1', 'registry.example/local:1']) {
      const failure = await images.addImage(ref, 'x').catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'BAD_REQUEST', message: refusal });
    }

    // a create that fails leaves no work directory behind
    const imagesDir = join(dataDir, 'images');
    const left = existsSync(imagesDir) ? readdirSync(imagesDir) : [];

    expect(left.filter((entry) => entry.startsWith('.build-'))).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('it refuses a build context that is not on the impd host', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: (_bytes, task) => task(),
        withGrowingRoom: (task) => task(() => Promise.resolve()),
      },
      readBuilders: () => null,
      log: () => {},
    });

    const failure = await images
      .buildImage(`${dataDir}/no-such-dir`, 'x')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain('does not exist on the impd host');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a rootfs is its tree plus room to spare, in whole GiB, at least 4 GiB', () => {
  const GIB = 1024 ** 3;

  expect(planRootfs({ bytes: 300 * 1024 ** 2, inodes: 20_000 })).toEqual({
    bytes: 4 * GIB,
    inodes: null,
  });

  expect(planRootfs({ bytes: 5 * GIB, inodes: 90_000 })).toEqual({ bytes: 8 * GIB, inodes: null });

  // node_modules: many small files need more inodes than 16 KiB each gives
  expect(planRootfs({ bytes: GIB, inodes: 400_000 })).toEqual({ bytes: 4 * GIB, inodes: 800_000 });
});

test('a build context on the impd host with no Dockerfile is the client’s mistake', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: (_bytes, task) => task(),
        withGrowingRoom: (task) => task(() => Promise.resolve()),
      },
      readBuilders: () => null,
      log: () => {},
    });

    const failure = await images.buildImage(dataDir, 'x').catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain('there is no Dockerfile');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a build context on the impd host over IMP_BUILD_CONTEXT_MAX_MIB is refused before it is sent', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir, IMP_BUILD_CONTEXT_MAX_MIB: '1' }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: (_bytes, task) => task(),
        withGrowingRoom: (task) => task(() => Promise.resolve()),
      },
      readBuilders: () => null,
      log: () => {},
    });

    writeFileSync(`${dataDir}/Dockerfile`, 'FROM scratch\n');
    writeFileSync(`${dataDir}/big`, new Uint8Array(2 * 1024 ** 2));

    const failure = await images.buildImage(dataDir, 'x').catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain('over the limit of 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a Dockerfile path is sent in one spelling, the one the proxy lets through', () => {
  for (const [given, normalized] of [
    [undefined, 'Dockerfile'],
    ['./Dockerfile', 'Dockerfile'],
    ['sub//./web.Dockerfile', 'sub/web.Dockerfile'],
    ['a/../Dockerfile', 'Dockerfile'],
  ] as const) {
    const path = normalizeDockerfilePath(given);

    const query = new Map([
      ['t', ['imp/x:latest']],
      ['version', ['2']],
      ['buildargs', [JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })]],
      ['dockerfile', [path]],
    ]);

    expect(path).toBe(normalized);
    expect(checkBuildQuery(query)).toEqual({ isOk: true });
  }
});

test('a Dockerfile path that leaves the context, or names it, is refused', () => {
  for (const path of ['../Dockerfile', 'a/../../Dockerfile', '/etc/passwd', '.', 'sub/']) {
    expect(() => normalizeDockerfilePath(path)).toThrow('not a file inside the build context');
  }
});
