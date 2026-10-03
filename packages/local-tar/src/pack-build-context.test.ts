import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MissingDockerfileError, listContextEntries } from './pack-build-context';

// a directory with these files (relative path → content), removed on dispose
function createContext(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), 'imp-context-'));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return {
    root,
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function listNames(root: string, dockerfile = 'Dockerfile'): Promise<string[]> {
  const entries = await listContextEntries(root, dockerfile);

  return entries.map((entry) => entry.name);
}

test('it leaves out what .dockerignore matches, with docker’s rules', async () => {
  using ctx = createContext({
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

  const names = await listNames(ctx.root);

  expect(names).toEqual([
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

test('the Dockerfile goes even when the ignore file matches it', async () => {
  using ctx = createContext({
    'docker/Dockerfile': 'FROM scratch',
    '.dockerignore': '*\n',
    'app.js': '',
  });

  const names = await listNames(ctx.root, './docker/Dockerfile');

  expect(names).toEqual(['docker', 'docker/Dockerfile']);
});

test('<Dockerfile>.dockerignore wins, and .dockerignore is then an ordinary file', async () => {
  using ctx = createContext({
    'web.Dockerfile': 'FROM scratch',
    'web.Dockerfile.dockerignore': 'secret\n',
    '.dockerignore': 'app.js\n',
    'app.js': '',
    secret: '',
  });

  const names = await listNames(ctx.root, 'web.Dockerfile');

  expect(names).toEqual([
    '.dockerignore',
    'app.js',
    'web.Dockerfile',
    'web.Dockerfile.dockerignore',
  ]);

  writeFileSync(join(ctx.root, 'web.Dockerfile.dockerignore'), '.dockerignore\n*.dockerignore\n');

  const without = await listNames(ctx.root, 'web.Dockerfile');

  expect(without).toEqual(['app.js', 'secret', 'web.Dockerfile']);
});

test('symlinks stay links and modes keep their exec bits', async () => {
  using ctx = createContext({ Dockerfile: 'FROM scratch', 'run.sh': '#!/bin/sh\n' });

  chmodSync(join(ctx.root, 'run.sh'), 0o755);
  symlinkSync('run.sh', join(ctx.root, 'start'));

  const entries = await listContextEntries(ctx.root, 'Dockerfile');

  const script = entries.find((entry) => entry.name === 'run.sh');
  const link = entries.find((entry) => entry.name === 'start');

  expect(script?.mode).toBe(0o755);
  expect(link?.kind).toBe('symlink');
});

test('a missing Dockerfile is a MissingDockerfileError', async () => {
  using ctx = createContext({ 'app.js': '' });

  const failure = await listContextEntries(ctx.root, 'Dockerfile').catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(MissingDockerfileError);
  expect(String(failure)).toContain('there is no Dockerfile');
});

test('a lowercase dockerfile stands in for a missing Dockerfile, with its own ignore file', async () => {
  using ctx = createContext({
    dockerfile: 'FROM scratch',
    'dockerfile.dockerignore': '*\n',
    '.dockerignore': '',
    'app.js': '',
  });

  using both = createContext({ Dockerfile: 'FROM scratch', dockerfile: 'FROM scratch' });

  const lower = await listNames(ctx.root);
  const dotted = await listNames(ctx.root, './Dockerfile');
  const upper = await listNames(both.root);

  expect(lower).toEqual(['dockerfile']);
  expect(dotted).toEqual(['dockerfile']);
  expect(upper).toEqual(['Dockerfile', 'dockerfile']);
});
