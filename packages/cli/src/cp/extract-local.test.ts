import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tar from 'tar-stream';
import type { Header } from 'tar-stream';
import type { CopyProgress } from './copy-progress';
import { createLocalExtractor } from './extract-local';

type TestEntry = Partial<Header> & Pick<Header, 'name'> & { readonly content?: string };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));

  dirs.push(dir);

  return dir;
}

async function buildArchive(entries: readonly Readonly<TestEntry>[]): Promise<Uint8Array> {
  const pack = tar.pack();

  for (const { content, ...header } of entries) {
    if (content === undefined) {
      pack.entry({ mode: 0o755, ...header });
    } else {
      pack.entry({ mode: 0o644, type: 'file', ...header }, content);
    }
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  return Buffer.concat(chunks);
}

function createTestProgress() {
  const seen = { total: null as number | null, copied: 0 };

  const progress: CopyProgress = {
    setTotal: (bytes) => {
      seen.total = bytes;
    },
    add: (bytes) => {
      seen.copied += bytes;
    },
    finish: () => {},
  };

  return { progress, seen };
}

// extracts the archive in two chunks, as it arrives from the imp
async function runExtract(dest: string, entries: readonly Readonly<TestEntry>[]) {
  const archive = await buildArchive(entries);

  const warnings: string[] = [];
  const tested = createTestProgress();

  const extractor = createLocalExtractor(dest, tested.progress, (text) => {
    warnings.push(text);
  });

  await extractor.write(archive.subarray(0, 700));
  await extractor.write(archive.subarray(700));

  const refused = await extractor.end();

  return { refused, warnings, seen: tested.seen };
}

test('the copy keeps modes and symlinks, and reads the total from the first entry', async () => {
  const dest = createTempDir();

  const result = await runExtract(dest, [
    { name: 'proj/', type: 'directory', mode: 0o750, pax: { 'IMP.total': '5' } },
    { name: 'proj/run', content: 'hello', mode: 0o755 },
    { name: 'proj/link', type: 'symlink', linkname: 'run' },
  ]);

  expect(result).toMatchObject({ refused: 0, warnings: [], seen: { total: 5, copied: 5 } });
  expect(readFileSync(join(dest, 'proj', 'run'), 'utf8')).toBe('hello');
  expect(statSync(join(dest, 'proj', 'run')).mode & 0o777).toBe(0o755);
  expect(statSync(join(dest, 'proj')).mode & 0o777).toBe(0o750);
  expect(readlinkSync(join(dest, 'proj', 'link'))).toBe('run');
});

test('a dest that is not a directory takes the name of the top', async () => {
  const dest = join(createTempDir(), 'renamed');

  await runExtract(dest, [{ name: 'x.log', content: 'log' }]);

  expect(readFileSync(dest, 'utf8')).toBe('log');
});

test('names that leave the copy are refused, and the rest extracts', async () => {
  const dest = createTempDir();

  const result = await runExtract(dest, [
    { name: 'src/', type: 'directory' },
    { name: 'src/../escape', content: 'x' },
    { name: '/tmp/escape', content: 'x' },
    { name: 'other/escape', content: 'x' },
    { name: 'src/ok', content: 'fine' },
  ]);

  expect(result.refused).toBe(3);
  expect(readFileSync(join(dest, 'src', 'ok'), 'utf8')).toBe('fine');

  const escaped = await lstat(join(dest, 'escape')).catch(() => null);

  expect(escaped).toBeNull();
});

test('a symlink and then a file through it: the file is refused', async () => {
  const dest = createTempDir();
  const outside = createTempDir();

  const result = await runExtract(dest, [
    { name: 'src/', type: 'directory' },
    { name: 'src/link', type: 'symlink', linkname: outside },
    { name: 'src/link/planted', content: 'x' },
  ]);

  const planted = await lstat(join(outside, 'planted')).catch(() => null);

  expect(result.refused).toBe(1);
  expect(planted).toBeNull();
  expect(readlinkSync(join(dest, 'src', 'link'))).toBe(outside);
});

test('a symlink already on this machine is not written through', async () => {
  const dest = createTempDir();
  const outside = createTempDir();

  mkdirSync(join(dest, 'src'));
  symlinkSync(outside, join(dest, 'src', 'sub'));

  const result = await runExtract(dest, [
    { name: 'src/', type: 'directory' },
    { name: 'src/sub/planted', content: 'x' },
  ]);

  const planted = await lstat(join(outside, 'planted')).catch(() => null);

  expect(result.refused).toBe(1);
  expect(result.warnings[0]).toContain('not a directory');
  expect(planted).toBeNull();
});

test('a hard link must stay inside the copy; devices are skipped, setuid dropped', async () => {
  const dest = createTempDir();

  const result = await runExtract(dest, [
    { name: 'src/', type: 'directory' },
    { name: 'src/a', content: 'same', mode: 0o6755 },
    { name: 'src/b', type: 'link', linkname: 'src/a' },
    { name: 'src/c', type: 'link', linkname: '/etc/passwd' },
    { name: 'src/null', type: 'character-device', devmajor: 1, devminor: 3 },
  ]);

  const outsideLink = await lstat(join(dest, 'src', 'c')).catch(() => null);
  const device = await lstat(join(dest, 'src', 'null')).catch(() => null);

  expect(result.refused).toBe(1);
  expect(readFileSync(join(dest, 'src', 'b'), 'utf8')).toBe('same');
  expect(statSync(join(dest, 'src', 'a')).mode & 0o7777).toBe(0o755);
  expect([outsideLink, device]).toEqual([null, null]);
  expect(result.warnings.some((warning) => warning.includes('skipped'))).toBeTrue();
});

test('a write past the extract buffer resolves once the extract took it', async () => {
  const dest = createTempDir();
  const size = 1_048_576;

  const archive = await buildArchive([{ name: 'big.bin', content: 'x'.repeat(size) }]);

  const tested = createTestProgress();
  const extractor = createLocalExtractor(dest, tested.progress, () => {});
  const written = extractor.write(archive);

  expect(Bun.peek.status(written)).toBe('pending');

  await written;

  expect(tested.seen.copied).toBeGreaterThan(size - 65_536);

  const refused = await extractor.end();

  expect(refused).toBe(0);
});

test('a write that waits is woken when the extract fails', async () => {
  const dest = createTempDir();

  const archive = await buildArchive([{ name: '../big.bin', content: 'x'.repeat(1_048_576) }]);

  const extractor = createLocalExtractor(dest, createTestProgress().progress, () => {});

  await extractor.write(archive);

  const failure = await extractor.end().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
});
