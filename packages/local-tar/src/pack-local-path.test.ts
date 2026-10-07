import { expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import {
  countFileBytes,
  countTarBytes,
  listLocalEntries,
  writeLocalEntries,
} from './pack-local-path';
import { createStubTree } from './test-utils/create-stub-tree';
import { readTarEntries } from './test-utils/read-tar-entries';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const root = await mkdtemp(join(tmpdir(), 'imp-local-path-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const owned = stack.move();

  return { root, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('#listLocalEntries lists the path and everything under it, parents first, named from its base', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { 'top/b.sh': 'run', 'top/a/c.txt': 'c' });
  await chmod(join(ctx.root, 'top/b.sh'), 0o755);
  await symlink('b.sh', join(ctx.root, 'top/link'));

  // a symlink's own mode differs by platform: 0o777 on Linux, not on macOS
  const link = await lstat(join(ctx.root, 'top/link'));

  const linkMode = link.mode & 0o7777;

  const entries: unknown = await listLocalEntries(join(ctx.root, 'top'));

  expect(entries).toStrictEqual([
    {
      path: join(ctx.root, 'top'),
      name: 'top',
      kind: 'directory',
      size: expect.any(Number) as unknown,
      mode: expect.any(Number) as unknown,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'top/a'),
      name: 'top/a',
      kind: 'directory',
      size: expect.any(Number) as unknown,
      mode: expect.any(Number) as unknown,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'top/a/c.txt'),
      name: 'top/a/c.txt',
      kind: 'file',
      size: 1,
      mode: expect.any(Number) as unknown,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'top/b.sh'),
      name: 'top/b.sh',
      kind: 'file',
      size: 3,
      mode: 0o755,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'top/link'),
      name: 'top/link',
      kind: 'symlink',
      size: 4,
      mode: linkMode,
      mtimeMs: expect.any(Number) as unknown,
    },
  ]);
});

test('#listLocalEntries lists a FIFO as an other entry', async () => {
  await using ctx = await setupTest();

  await mkdir(join(ctx.root, 'top'));
  await $`mkfifo ${join(ctx.root, 'top/pipe')}`;

  const entries: unknown = await listLocalEntries(join(ctx.root, 'top'));

  expect(entries).toStrictEqual([
    {
      path: join(ctx.root, 'top'),
      name: 'top',
      kind: 'directory',
      size: expect.any(Number) as unknown,
      mode: expect.any(Number) as unknown,
      mtimeMs: expect.any(Number) as unknown,
    },
    {
      path: join(ctx.root, 'top/pipe'),
      name: 'top/pipe',
      kind: 'other',
      size: 0,
      mode: expect.any(Number) as unknown,
      mtimeMs: expect.any(Number) as unknown,
    },
  ]);
});

test('#countFileBytes sums the sizes of the files and nothing else', () => {
  expect(
    countFileBytes([
      { path: '/x/top', name: 'top', kind: 'directory', size: 4096, mode: 0o755, mtimeMs: 0 },
      { path: '/x/top/a', name: 'top/a', kind: 'file', size: 10, mode: 0o644, mtimeMs: 0 },
      { path: '/x/top/b', name: 'top/b', kind: 'file', size: 5, mode: 0o644, mtimeMs: 0 },
      { path: '/x/top/l', name: 'top/l', kind: 'symlink', size: 1, mode: 0o777, mtimeMs: 0 },
      { path: '/x/top/p', name: 'top/p', kind: 'other', size: 0, mode: 0o644, mtimeMs: 0 },
    ]),
  ).toBe(15);
});

test('#countTarBytes counts the length of the tar writeLocalEntries makes', async () => {
  await using ctx = await setupTest();

  const top = join(ctx.root, 'top');

  await mkdir(join(top, 'deep/'.repeat(30)), { recursive: true });
  await writeFile(join(top, 'empty'), '');
  await writeFile(join(top, 'odd'), 'x'.repeat(513));
  await writeFile(join(top, 'block'), 'x'.repeat(1024));
  await writeFile(join(top, 'ünïcode'), 'pax for a utf-8 name');
  await writeFile(join(top, 'n'.repeat(140)), 'pax for a long name');
  await symlink('t'.repeat(150), join(top, 'far'));

  const entries = await listLocalEntries(top);

  const chunks: Uint8Array[] = [];

  await writeLocalEntries(
    entries,
    (chunk) => {
      chunks.push(chunk);

      return Promise.resolve();
    },
    { add: () => {} },
    () => {},
  );

  const counted = await countTarBytes(entries);

  expect(counted).toBe(Bun.concatArrayBuffers(chunks).byteLength);
});

test('#writeLocalEntries writes a tar of the directories, files and symlinks', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { 'top/a.txt': 'alpha' });
  await symlink('a.txt', join(ctx.root, 'top/link'));

  const entries = await listLocalEntries(join(ctx.root, 'top'));

  const chunks: Uint8Array[] = [];

  await writeLocalEntries(
    entries,
    (chunk) => {
      chunks.push(chunk);

      return Promise.resolve();
    },
    { add: () => {} },
    () => {},
  );

  const written = await readTarEntries(new Uint8Array(Bun.concatArrayBuffers(chunks)));

  expect(
    written.map((entry) => [
      entry.header.name,
      entry.header.type,
      entry.header.linkname,
      entry.content,
    ]),
  ).toStrictEqual([
    ['top/', 'directory', null, ''],
    ['top/a.txt', 'file', null, 'alpha'],
    ['top/link', 'symlink', 'a.txt', ''],
  ]);
});

test('#writeLocalEntries reports the bytes of each file to progress as it packs them', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { 'top/a.txt': 'alpha', 'top/b.txt': 'be' });

  const entries = await listLocalEntries(join(ctx.root, 'top'));

  const added: number[] = [];

  await writeLocalEntries(
    entries,
    () => Promise.resolve(),
    {
      add: (bytes) => {
        added.push(bytes);
      },
    },
    () => {},
  );

  expect(added).toStrictEqual([5, 2]);
});

test('#writeLocalEntries warns about and leaves out an entry that is not a file, directory or symlink', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { 'top/a.txt': 'alpha' });
  await $`mkfifo ${join(ctx.root, 'top/pipe')}`;

  const entries = await listLocalEntries(join(ctx.root, 'top'));

  const chunks: Uint8Array[] = [];
  const warnings: string[] = [];

  await writeLocalEntries(
    entries,
    (chunk) => {
      chunks.push(chunk);

      return Promise.resolve();
    },
    { add: () => {} },
    (text) => {
      warnings.push(text);
    },
  );

  const written = await readTarEntries(new Uint8Array(Bun.concatArrayBuffers(chunks)));

  expect(warnings).toStrictEqual([
    `${join(ctx.root, 'top/pipe')}: not a file, directory or symlink; left out`,
  ]);

  expect(written.map((entry) => entry.header.name)).toStrictEqual(['top/', 'top/a.txt']);
});
