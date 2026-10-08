import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLocalEntries } from '@imp/local-tar';
import { writeContextTar } from './write-context-tar';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-context-tar-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it writes the entries as a tar that holds each of them by name', async () => {
  const ctx = await setupTest();

  const context = join(ctx.dir, 'context');

  mkdirSync(join(context, 'src'), { recursive: true });
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(context, 'src', 'a.txt'), 'a\n');

  const entries = await listLocalEntries(context);

  await writeContextTar(entries, join(ctx.dir, 'context.tar'));

  const listed = Bun.spawnSync(['tar', '-tf', join(ctx.dir, 'context.tar')]).stdout.toString();

  expect(listed.trim().split('\n')).toStrictEqual([
    'context/',
    'context/Dockerfile',
    'context/src/',
    'context/src/a.txt',
  ]);
});

test('it writes the content of each file into the tar', async () => {
  const ctx = await setupTest();

  const context = join(ctx.dir, 'context');

  mkdirSync(context);
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\n');

  const entries = await listLocalEntries(context);

  await writeContextTar(entries, join(ctx.dir, 'context.tar'));

  const read = Bun.spawnSync(['tar', '-xOf', join(ctx.dir, 'context.tar'), 'context/Dockerfile']);

  expect(read.stdout.toString()).toBe('FROM scratch\n');
});

test('it writes the tar readable by impd alone', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'Dockerfile'), 'FROM scratch\n');

  await writeContextTar(
    [
      {
        path: join(ctx.dir, 'Dockerfile'),
        name: 'Dockerfile',
        kind: 'file',
        size: 13,
        mode: 0o644,
        mtimeMs: 0,
      },
    ],
    join(ctx.dir, 'context.tar'),
  );

  expect(statSync(join(ctx.dir, 'context.tar')).mode & 0o777).toBe(0o600);
});

test('it refuses a path that exists already', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'context.tar'), 'old');

  expect(writeContextTar([], join(ctx.dir, 'context.tar'))).rejects.toMatchObject({
    code: 'EEXIST',
  });
});
