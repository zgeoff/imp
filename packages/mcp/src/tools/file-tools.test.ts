import { expect, onTestFinished, test } from 'bun:test';
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

// The write script runs under this host's /bin/sh, as a guest's runs it; the
// e2e suite runs it in BusyBox and in impd's default image.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-write-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it creates the parent directories and leaves no temp file', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, '-a b', '$(x)', 'f.txt');

  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path], {
    stdin: new TextEncoder().encode('hello'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const code = await proc.exited;

  expect(code).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe('hello');
  expect(readdirSync(join(ctx.dir, '-a b', '$(x)'))).toStrictEqual(['f.txt']);
});

test('it keeps the mode of a file that exists', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'f');

  writeFileSync(path, 'old');
  chmodSync(path, 0o600);

  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path], {
    stdin: new TextEncoder().encode('new'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const code = await proc.exited;

  expect(code).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe('new');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('it writes through a symlink without replacing it', async () => {
  const ctx = setupTest();
  const target = join(ctx.dir, 'real');
  const link = join(ctx.dir, 'link');

  writeFileSync(target, 'old');
  symlinkSync(target, link);

  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', link], {
    stdin: new TextEncoder().encode('new'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const code = await proc.exited;

  expect(code).toBe(0);
  expect(lstatSync(link).isSymbolicLink()).toBeTrue();
  expect(readFileSync(target, 'utf8')).toBe('new');
});

test('it refuses a directory and leaves it as it was', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'sub');

  mkdirSync(path);
  writeFileSync(join(path, 'keep'), 'x');

  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path], {
    stdin: new TextEncoder().encode('new'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  expect({ code, stderr }).toStrictEqual({ code: 1, stderr: `${path} is a directory\n` });
  expect(readdirSync(path)).toStrictEqual(['keep']);
});

// Content past a pipe buffer, written as the agent writes it while the script
// refuses: the script must read it all, or the write fails with EPIPE and the
// refusal is lost (#185).
test('it reads all the content of a write it refuses for a directory', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'sub');

  mkdirSync(path);

  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const written = (async () => {
    await proc.stdin.write(new Uint8Array(4 << 20).fill(120));
    await proc.stdin.end();
  })();

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  await expect(written).toResolve();

  expect({ code, stderr }).toStrictEqual({ code: 1, stderr: `${path} is a directory\n` });
});

test('it reads all the content of a write it refuses for a symlink it cannot resolve', async () => {
  const ctx = setupTest();
  const loop = join(ctx.dir, 'loop');
  const link = join(ctx.dir, 'dangling');

  symlinkSync(loop, loop);
  symlinkSync(loop, link);

  const proc = Bun.spawn(['/bin/sh', '-c', WRITE_SCRIPT, 'sh', link], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const written = (async () => {
    await proc.stdin.write(new Uint8Array(4 << 20).fill(120));
    await proc.stdin.end();
  })();

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  await expect(written).toResolve();

  expect({ code, stderr }).toStrictEqual({
    code: 1,
    stderr: `cannot resolve the symlink ${link}\n`,
  });
});
