import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissingDockerfileError, listContextEntries } from './pack-build-context';
import { createStubTree } from './test-utils/create-stub-tree';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const root = await mkdtemp(join(tmpdir(), 'imp-context-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const owned = stack.move();

  return { root, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it leaves out what .dockerignore matches, with docker’s rules', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, {
    Dockerfile: 'FROM scratch',
    '.dockerignore': '*.log\n!keep.log\nnode_modules\nbuild/**\n!build/keep/**\n',
    'app.js': '',
    'a.log': '',
    'keep.log': '',
    'sub/b.log': '',
    'node_modules/x/y.js': '',
    'build/out.o': '',
    'build/keep/k.txt': '',
  });

  const entries = await listContextEntries(ctx.root, 'Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual([
    '.dockerignore',
    'Dockerfile',
    'app.js',
    'build',
    'build/keep',
    'build/keep/k.txt',
    'keep.log',
    'sub',
    'sub/b.log',
  ]);
});

test('it keeps the Dockerfile when the ignore file matches it', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, {
    'docker/Dockerfile': 'FROM scratch',
    '.dockerignore': '*\n',
    'app.js': '',
  });

  const entries = await listContextEntries(ctx.root, './docker/Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual(['docker', 'docker/Dockerfile']);
});

test('it applies <Dockerfile>.dockerignore in place of .dockerignore', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, {
    'web.Dockerfile': 'FROM scratch',
    'web.Dockerfile.dockerignore': 'secret\n',
    '.dockerignore': 'app.js\n',
    'app.js': '',
    secret: '',
  });

  const entries = await listContextEntries(ctx.root, 'web.Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual([
    '.dockerignore',
    'app.js',
    'web.Dockerfile',
    'web.Dockerfile.dockerignore',
  ]);
});

test('it leaves out .dockerignore as an ordinary file under <Dockerfile>.dockerignore', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, {
    'web.Dockerfile': 'FROM scratch',
    'web.Dockerfile.dockerignore': '.dockerignore\n*.dockerignore\n',
    '.dockerignore': 'app.js\n',
    'app.js': '',
    secret: '',
  });

  const entries = await listContextEntries(ctx.root, 'web.Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual(['app.js', 'secret', 'web.Dockerfile']);
});

test('it lists a symlink as a link and a file with its exec bits', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { Dockerfile: 'FROM scratch', 'run.sh': '#!/bin/sh\n' });
  await chmod(join(ctx.root, 'run.sh'), 0o755);
  await symlink('run.sh', join(ctx.root, 'start'));

  const entries: unknown = await listContextEntries(ctx.root, 'Dockerfile');

  expect(entries).toStrictEqual([
    {
      path: join(ctx.root, 'Dockerfile'),
      name: 'Dockerfile',
      kind: 'file',
      size: 12,
      mode: expect.any(Number) as unknown,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'run.sh'),
      name: 'run.sh',
      kind: 'file',
      size: 10,
      mode: 0o755,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'start'),
      name: 'start',
      kind: 'symlink',
      size: 6,
      mode: 0o777,
      mtimeMs: expect.any(Number) as unknown,
    },
  ]);
});

test('it rejects a context with no Dockerfile', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { 'app.js': '' });

  expect(listContextEntries(ctx.root, 'Dockerfile')).rejects.toThrowWithMessage(
    MissingDockerfileError,
    `there is no Dockerfile in ${ctx.root}`,
  );
});

test('it lists a lowercase dockerfile in place of a missing Dockerfile, with its own ignore file', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, {
    dockerfile: 'FROM scratch',
    'dockerfile.dockerignore': '*\n',
    '.dockerignore': '',
    'app.js': '',
  });

  const entries = await listContextEntries(ctx.root, 'Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual(['dockerfile']);
});

test('it lists a lowercase dockerfile in place of a missing ./Dockerfile', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { dockerfile: 'FROM scratch', 'app.js': '' });

  const entries = await listContextEntries(ctx.root, './Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual(['app.js', 'dockerfile']);
});

test('it lists both Dockerfile and dockerfile when the context has both', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { Dockerfile: 'FROM scratch', dockerfile: 'FROM scratch' });

  const entries = await listContextEntries(ctx.root, 'Dockerfile');

  expect(entries.map((entry) => entry.name)).toStrictEqual(['Dockerfile', 'dockerfile']);
});
