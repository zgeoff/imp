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

// Content past a pipe buffer, written as the agent writes it while the
// script refuses: it must read it all, or the write fails with EPIPE and
// the refusal is lost (#185)
async function runWriteThroughPipe(path: string, bytes: number) {
  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const written = (async () => {
    try {
      await proc.stdin.write(new Uint8Array(bytes).fill(120));
      await proc.stdin.end();

      return 'ok';
    } catch (error) {
      return String(error);
    }
  })();

  const [code, stderr, write] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    written,
  ]);

  return { code, stderr, write };
}

test('a refused write still reads all its content, so the refusal is what comes back', async () => {
  const directory = join(dir, 'sub');
  const link = join(dir, 'dangling');

  mkdirSync(directory);
  symlinkSync(join(dir, 'loop'), join(dir, 'loop'));
  symlinkSync(join(dir, 'loop'), link);

  const outcomes = await Promise.all([
    runWriteThroughPipe(directory, 4 << 20),
    runWriteThroughPipe(link, 4 << 20),
  ]);

  expect(outcomes).toEqual([
    { code: 1, stderr: `${directory} is a directory\n`, write: 'ok' },
    { code: 1, stderr: `cannot resolve the symlink ${link}\n`, write: 'ok' },
  ]);
});
