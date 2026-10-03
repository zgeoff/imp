import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { DockerBuildError } from './docker-build';
import { createFakeGuest } from './fake-guest';
import type { FakeAnswer, FakeRun } from './fake-guest';
import { runGuestBuild, writeGuestTree } from './guest-build';
import { GuestOutputError, createGuestExec } from './guest-exec';
import { ImageLimitError } from './image-limit-error';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imp-guest-build-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CONTAINER_ID = 'c'.repeat(64);
const CONFIG = '{"Cmd":["sh"],"Env":["A=1"]}';
const CHUNK_BYTES = 64 * 1024;

// a tar of a tree with one file, as docker export streams it, in chunks
function buildExport(content: string): Uint8Array[] {
  const tree = join(dir, `tree-${Bun.randomUUIDv7()}`);

  mkdirSync(join(tree, 'etc'), { recursive: true });
  writeFileSync(join(tree, 'etc', 'hello'), content);

  const tar = Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout;
  const chunks: Uint8Array[] = [];

  for (let at = 0; at < tar.byteLength; at += CHUNK_BYTES) {
    chunks.push(tar.subarray(at, at + CHUNK_BYTES));
  }

  return chunks;
}

// a builder whose engine has built imp-build:latest, and exports `exported`
function createExportAnswer(exported: readonly Uint8Array[]) {
  return (run: FakeRun): FakeAnswer => {
    const command = run.argv.slice(1, 3).join(' ');

    if (command === 'image inspect') {
      return { stdout: `${CONFIG}\n` };
    }

    if (command === `create imp-build:latest`) {
      return { stdout: `${CONTAINER_ID}\n` };
    }

    if (command === `export ${CONTAINER_ID}`) {
      return { stdout: exported };
    }

    return { code: 1, stderr: `unexpected: ${run.argv.join(' ')}` };
  };
}

test('the export unpacks into root, and its digest is of the config and the stream', async () => {
  const exported = buildExport('hi\n'.repeat(100_000));
  const guest = createFakeGuest(createExportAnswer(exported));
  const root = join(dir, 'root');

  mkdirSync(root);

  const image = await writeGuestTree(
    createGuestExec(guest.open),
    root,
    { maxBytes: 1024 ** 3, maxFiles: 100 },
    new AbortController().signal,
  );

  const hash = new Bun.CryptoHasher('sha256');
  const length = new Uint8Array(8);

  new DataView(length.buffer).setBigUint64(0, BigInt(CONFIG.length));

  hash.update('imp build image v1\n');
  hash.update(length);
  hash.update(CONFIG);

  for (const chunk of exported) {
    hash.update(chunk);
  }

  expect(image).toEqual({
    digest: `imp-build-${hash.digest('hex')}`,
    config: { Cmd: ['sh'], Env: ['A=1'] },
  });

  expect(readFileSync(join(root, 'etc', 'hello'), 'utf8')).toBe('hi\n'.repeat(100_000));

  expect(guest.runs.map((run) => run.argv.join(' '))).toEqual([
    'docker image inspect --format {{json .Config}} imp-build:latest',
    'docker create imp-build:latest /bin/true',
    `docker export ${CONTAINER_ID}`,
  ]);
});

test('an export past the cap stops at the cap, and its exec is ended', async () => {
  const exported = buildExport('x'.repeat(4 * CHUNK_BYTES));
  const guest = createFakeGuest(createExportAnswer(exported));
  const root = join(dir, 'root');

  mkdirSync(root);

  const failure = await writeGuestTree(
    createGuestExec(guest.open),
    root,
    { maxBytes: 2 * CHUNK_BYTES, maxFiles: 100 },
    new AbortController().signal,
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ImageLimitError);
  expect(String(failure)).toContain('(IMP_BUILD_IMAGE_MAX_MIB)');
  expect(guest.runs.at(-1)?.closed).toBe(true);
});

test('an export of more entries than the file cap is refused as tar counts them', async () => {
  const tree = join(dir, 'many');

  mkdirSync(tree);

  for (let n = 0; n < 50; n += 1) {
    writeFileSync(join(tree, `f${String(n)}`), '');
  }

  const exported = [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout];
  const guest = createFakeGuest(createExportAnswer(exported));
  const root = join(dir, 'root');

  mkdirSync(root);

  const failure = await writeGuestTree(
    createGuestExec(guest.open),
    root,
    { maxBytes: 1024 ** 3, maxFiles: 10 },
    new AbortController().signal,
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ImageLimitError);
  expect(String(failure)).toContain('is over 10 files (IMP_BUILD_IMAGE_MAX_FILES)');
});

test("a builder's config that is not one JSON object is refused", async () => {
  const guest = createFakeGuest(() => ({ stdout: '["not", "a", "config"]\n' }));

  const failure = await writeGuestTree(
    createGuestExec(guest.open),
    dir,
    { maxBytes: 1024, maxFiles: 100 },
    new AbortController().signal,
  ).catch((error: unknown) => error);

  expect(String(failure)).toContain('expected record');
  expect(guest.runs).toHaveLength(1);
});

test('the build reads its context from stdin, and a failed one returns its log, capped', async () => {
  const contextPath = join(dir, 'context.tar');
  const stdins: string[] = [];

  writeFileSync(contextPath, 'the context');

  const guest = createFakeGuest(async (run) => {
    const stdin = await run.readStdin();

    stdins.push(new TextDecoder().decode(stdin));

    return { code: 1, stderr: `${'early '.repeat(2000)}\n#5 ERROR: process "/bin/sh -c false"` };
  });

  const failure = await runGuestBuild(createGuestExec(guest.open), {
    tarPath: contextPath,
    dockerfile: 'sub/Dockerfile',
    signal: new AbortController().signal,
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(DockerBuildError);

  const message = failure instanceof Error ? failure.message : '';

  expect(message).toStartWith('docker build failed:\n');
  expect(message.endsWith('#5 ERROR: process "/bin/sh -c false"')).toBe(true);
  expect(message.length).toBeLessThanOrEqual('docker build failed:\n'.length + 8000);
  expect(stdins).toEqual(['the context']);

  expect(guest.runs[0]?.argv).toEqual([
    'docker',
    'build',
    '--progress=plain',
    '--build-arg',
    `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
    '--tag',
    'imp-build:latest',
    '--file',
    'sub/Dockerfile',
    '-',
  ]);
});

test('a step that writes past what impd keeps is refused, and one that hangs is killed', async () => {
  const big = createFakeGuest(() => ({
    stdout: ['x'.repeat(1024 ** 2), 'y'].map((text) => new TextEncoder().encode(text)),
  }));

  const tooBig = await createGuestExec(big.open)(['cat'], {
    signal: new AbortController().signal,
  }).catch((error: unknown) => error);

  expect(tooBig).toBeInstanceOf(GuestOutputError);

  const hanging = createFakeGuest(() => new Promise<FakeAnswer>(() => {}));

  const timedOut = await createGuestExec(hanging.open)(['sleep', 'inf'], {
    signal: new AbortController().signal,
    timeoutMs: 20,
  }).catch((error: unknown) => error);

  expect(String(timedOut)).toContain('sleep inf: no exit in 20 ms');
  expect(hanging.runs[0]).toMatchObject({ signals: [9], closed: true });
});
