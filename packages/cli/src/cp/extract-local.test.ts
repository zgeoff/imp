import { expect, mock, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAgentTar } from '../test-utils/build-stub-agent-tar';
import { createLocalExtractor } from './extract-local';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const root = await mkdtemp(join(tmpdir(), 'cp-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const owned = stack.move();

  return { root, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it keeps modes and symlinks and reads the total from the first entry', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');

  const progress = {
    setTotal: mock<(bytes: number) => void>(),
    add: mock<(bytes: number) => void>(),
    finish: mock<() => void>(),
  };

  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'proj/', type: 'directory', mode: 0o750, pax: { 'IMP.total': '5' } },
    { name: 'proj/run', content: 'hello', mode: 0o755 },
    { name: 'proj/link', type: 'symlink', linkname: 'run' },
  ]);

  // in two chunks, as it arrives from the imp
  const extractor = createLocalExtractor(dest, progress, warn);

  await extractor.write(archive.subarray(0, 700));
  await extractor.write(archive.subarray(700));

  const refused = await extractor.end();

  expect(refused).toBe(0);
  expect(warn).not.toHaveBeenCalled();
  expect(progress.setTotal).toHaveBeenCalledExactlyOnceWith(5);
  expect(progress.add).toHaveBeenCalledExactlyOnceWith(5);
  expect(readFile(join(dest, 'proj', 'run'), 'utf8')).resolves.toBe('hello');

  const runStats = await stat(join(dest, 'proj', 'run'));
  const projStats = await stat(join(dest, 'proj'));

  expect(runStats.mode & 0o777).toBe(0o755);
  expect(projStats.mode & 0o777).toBe(0o750);
  expect(readlink(join(dest, 'proj', 'link'))).resolves.toBe('run');
});

test('it gives the top entry the name of a dest that is not a directory', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'renamed');

  const progress = {
    setTotal: mock<(bytes: number) => void>(),
    add: mock<(bytes: number) => void>(),
    finish: mock<() => void>(),
  };

  const archive = await buildStubAgentTar([{ name: 'x.log', content: 'log' }]);

  const extractor = createLocalExtractor(dest, progress, mock<(text: string) => void>());

  await extractor.write(archive);
  await extractor.end();

  expect(readFile(dest, 'utf8')).resolves.toBe('log');
});

test('it refuses names that leave the copy and extracts the rest', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');

  const progress = {
    setTotal: mock<(bytes: number) => void>(),
    add: mock<(bytes: number) => void>(),
    finish: mock<() => void>(),
  };

  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/../escape', content: 'x' },
    { name: '/tmp/escape', content: 'x' },
    { name: 'other/escape', content: 'x' },
    { name: 'src/ok', content: 'fine' },
  ]);

  const extractor = createLocalExtractor(dest, progress, warn);

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(3);

  expect(warn.mock.calls).toStrictEqual([
    ['src/../escape: a name with ".."'],
    ['/tmp/escape: an absolute name'],
    ["other/escape: outside the copy's top src"],
  ]);

  expect(readFile(join(dest, 'src', 'ok'), 'utf8')).resolves.toBe('fine');
  expect(lstat(join(dest, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it refuses an entry with an empty name inside the copy', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: './', type: 'directory' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith('./: an empty name');
});

test('it refuses a file written through a symlink from the same archive', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const outside = join(ctx.root, 'outside');
  const warn = mock<(text: string) => void>();

  await mkdir(dest);
  await mkdir(outside);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/link', type: 'symlink', linkname: outside },
    { name: 'src/link/planted', content: 'x' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(1);
  expect(lstat(join(outside, 'planted'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(readlink(join(dest, 'src', 'link'))).resolves.toBe(outside);
});

test('it never writes through a symlink already on this machine', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const outside = join(ctx.root, 'outside');
  const warn = mock<(text: string) => void>();

  await mkdir(join(dest, 'src'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(dest, 'src', 'sub'));

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/sub/planted', content: 'x' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(1);

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    `src/sub/planted: under ${join(dest, 'src', 'sub')}, which is not a directory`,
  );

  expect(lstat(join(outside, 'planted'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it refuses the copy when its destination is a symlink', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const outside = join(ctx.root, 'outside');

  await mkdir(dest);
  await mkdir(outside);
  await symlink(outside, join(dest, 'src'));

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/planted', content: 'x' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    mock<(text: string) => void>(),
  );

  await extractor.write(archive);

  expect(extractor.end()).rejects.toThrowWithMessage(
    Error,
    `${join(dest, 'src')} is a symlink; the copy will not go through it`,
  );

  expect(lstat(join(outside, 'planted'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it refuses an entry whose parent the archive never made', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/a/b', content: 'x' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith(`src/a/b: ${join(dest, 'src', 'a')} is missing`);
});

test('it links a hard link inside the copy and drops setuid', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/a', content: 'same', mode: 0o6755 },
    { name: 'src/b', type: 'link', linkname: 'src/a' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    mock<(text: string) => void>(),
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(0);
  expect(readFile(join(dest, 'src', 'b'), 'utf8')).resolves.toBe('same');

  const linked = await stat(join(dest, 'src', 'a'));

  expect(linked.mode & 0o7777).toBe(0o755);
});

test('it refuses a hard link to a name outside the copy', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/c', type: 'link', linkname: 'etc/passwd' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(1);

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'src/c: a hard link to etc/passwd, outside the copy',
  );

  expect(lstat(join(dest, 'src', 'c'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it refuses a hard link to a directory', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/sub/', type: 'directory' },
    { name: 'src/c', type: 'link', linkname: 'src/sub' },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith('src/c: a hard link to src/sub, not a file');
  expect(lstat(join(dest, 'src', 'c'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it skips a device with a warning', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.root, 'dest');
  const warn = mock<(text: string) => void>();

  await mkdir(dest);

  const archive = await buildStubAgentTar([
    { name: 'src/', type: 'directory' },
    { name: 'src/null', type: 'character-device', devmajor: 1, devminor: 3 },
  ]);

  const extractor = createLocalExtractor(
    dest,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    warn,
  );

  await extractor.write(archive);

  const refused = await extractor.end();

  expect(refused).toBe(0);
  expect(warn).toHaveBeenCalledExactlyOnceWith('src/null: not a file, directory or link; skipped');
  expect(lstat(join(dest, 'src', 'null'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it fails the copy when the imp sends an empty archive', async () => {
  await using ctx = await setupTest();

  const archive = await buildStubAgentTar([]);

  const extractor = createLocalExtractor(
    ctx.root,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    mock<(text: string) => void>(),
  );

  await extractor.write(archive);

  expect(extractor.end()).rejects.toThrowWithMessage(Error, 'the imp sent an empty archive');
});

test('it resolves a write past the extract buffer once the extract took it', async () => {
  await using ctx = await setupTest();

  const progress = {
    setTotal: mock<(bytes: number) => void>(),
    add: mock<(bytes: number) => void>(),
    finish: mock<() => void>(),
  };

  const archive = await buildStubAgentTar([{ name: 'big.bin', content: 'x'.repeat(1_048_576) }]);

  const extractor = createLocalExtractor(ctx.root, progress, mock<(text: string) => void>());
  const written = extractor.write(archive);

  expect(Bun.peek.status(written)).toBe('pending');

  await written;

  const copied = progress.add.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0);

  expect(copied).toBeGreaterThan(1_048_576 - 65_536);
});

test('it wakes a waiting write when the extract fails', async () => {
  await using ctx = await setupTest();

  const archive = await buildStubAgentTar([{ name: '../big.bin', content: 'x'.repeat(1_048_576) }]);

  const extractor = createLocalExtractor(
    ctx.root,
    {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    },
    mock<(text: string) => void>(),
  );

  await extractor.write(archive);

  expect(extractor.end()).rejects.toThrowWithMessage(Error, 'a name with ".."');
});
