import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WRITE_SCRIPT } from './file-tools';

// the write script under this host's /bin/sh, as a guest's runs it; the e2e
// suite runs it in BusyBox and in impd's default image
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imp-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runWrite(path: string, content: string) {
  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path], {
    stdin: new TextEncoder().encode(content),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  return { code, stderr };
}

test('it creates the parent directories and leaves no temp file', async () => {
  const path = join(dir, '-a b', '$(x)', 'f.txt');

  const result = await runWrite(path, 'hello');

  expect(result.code).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe('hello');
  expect(readdirSync(join(dir, '-a b', '$(x)'))).toEqual(['f.txt']);
});

test('a file that exists keeps its mode', async () => {
  const path = join(dir, 'f');

  writeFileSync(path, 'old');
  chmodSync(path, 0o600);

  await runWrite(path, 'new');

  expect(readFileSync(path, 'utf8')).toBe('new');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('a symlink is written through, not replaced', async () => {
  const target = join(dir, 'real');
  const link = join(dir, 'link');

  writeFileSync(target, 'old');
  symlinkSync(target, link);

  const result = await runWrite(link, 'new');

  expect(result.code).toBe(0);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('new');
});

test('a directory is refused and stays as it was', async () => {
  const path = join(dir, 'sub');

  mkdirSync(path);
  writeFileSync(join(path, 'keep'), 'x');

  const result = await runWrite(path, 'new');

  expect(result).toEqual({ code: 1, stderr: `${path} is a directory\n` });
  expect(readdirSync(path)).toEqual(['keep']);
});
