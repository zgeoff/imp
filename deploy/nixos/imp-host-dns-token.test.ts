import { expect, onTestFinished, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The DNS token's staging, as the NixOS module runs it before each start, on a change to the
// file, and every 5 minutes.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dns-token-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('it stages the token into a directory of its own, 0400, without printing it', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'dns-token'), 'cf-first\n');

  const result = Bun.spawnSync([
    'bash',
    new URL('imp-host-dns-token.sh', import.meta.url).pathname,
    join(ctx.dir, 'dns-token'),
    join(ctx.dir, 'run', 'dns'),
  ]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'run', 'dns', 'token'), 'utf8')).toBe('cf-first\n');
  expect(statSync(join(ctx.dir, 'run', 'dns', 'token')).mode & 0o777).toBe(0o400);
  expect(statSync(join(ctx.dir, 'run', 'dns')).mode & 0o777).toBe(0o700);

  expect(result.stdout.toString() + result.stderr.toString()).toBe(
    `imp-host-dns-token: staged the DNS API token from ${join(ctx.dir, 'dns-token')}\n`,
  );
});

test('it leaves the staged file untouched, silently, when the token has not changed', () => {
  const ctx = setupTest();

  const script = new URL('imp-host-dns-token.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'dns-token'), 'cf-first\n');

  Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  const inode = statSync(join(ctx.dir, 'dns', 'token')).ino;
  const result = Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString() + result.stderr.toString()).toBe('');
  expect(statSync(join(ctx.dir, 'dns', 'token')).ino).toBe(inode);
});

test('it stages a new token as a new file in the same directory, which the container mounts', () => {
  const ctx = setupTest();

  const script = new URL('imp-host-dns-token.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'dns-token'), 'cf-first\n');

  Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  const inode = statSync(join(ctx.dir, 'dns', 'token')).ino;
  const dirInode = statSync(join(ctx.dir, 'dns')).ino;

  writeFileSync(join(ctx.dir, 'dns-token'), 'cf-second\n');

  const result = Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'dns', 'token'), 'utf8')).toBe('cf-second\n');
  expect(statSync(join(ctx.dir, 'dns', 'token')).ino).not.toBe(inode);
  expect(statSync(join(ctx.dir, 'dns')).ino).toBe(dirInode);
  expect(readdirSync(join(ctx.dir, 'dns'))).toStrictEqual(['token']);
});

test('it waits, without failing the start, for a source that is missing before any token', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync([
    'bash',
    new URL('imp-host-dns-token.sh', import.meta.url).pathname,
    join(ctx.dir, 'dns-token'),
    join(ctx.dir, 'dns'),
  ]);

  expect(result.exitCode).toBe(0);

  expect(result.stderr.toString()).toInclude(
    'certificates and DNS records wait until it holds the token',
  );

  expect(readdirSync(join(ctx.dir, 'dns'))).toStrictEqual([]);
});

test.each([[''], [' \n']])(
  'it keeps the staged token, without failing the start, when the source holds %p',
  (content) => {
    const ctx = setupTest();

    const script = new URL('imp-host-dns-token.sh', import.meta.url).pathname;

    writeFileSync(join(ctx.dir, 'dns-token'), 'cf-good\n');

    Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

    writeFileSync(join(ctx.dir, 'dns-token'), content);

    const result = Bun.spawnSync([
      'bash',
      script,
      join(ctx.dir, 'dns-token'),
      join(ctx.dir, 'dns'),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toInclude('impd keeps the token staged before');
    expect(readFileSync(join(ctx.dir, 'dns', 'token'), 'utf8')).toBe('cf-good\n');
  },
);

test('it keeps the staged token, without failing the start, when the source is removed', () => {
  const ctx = setupTest();

  const script = new URL('imp-host-dns-token.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'dns-token'), 'cf-good\n');

  Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  rmSync(join(ctx.dir, 'dns-token'));

  const result = Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'dns', 'token'), 'utf8')).toBe('cf-good\n');
});

test('it keeps the staged token, without failing the start, when the source cannot be read', () => {
  const ctx = setupTest();

  const script = new URL('imp-host-dns-token.sh', import.meta.url).pathname;

  writeFileSync(join(ctx.dir, 'dns-token'), 'cf-good\n');

  Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  // a directory in the source's place
  rmSync(join(ctx.dir, 'dns-token'));
  mkdirSync(join(ctx.dir, 'dns-token'));

  const result = Bun.spawnSync(['bash', script, join(ctx.dir, 'dns-token'), join(ctx.dir, 'dns')]);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'dns', 'token'), 'utf8')).toBe('cf-good\n');
  expect(readdirSync(join(ctx.dir, 'dns'))).toStrictEqual(['token']);
});

test.each([[[]], [['/run/secrets/dns-token']]])(
  'it refuses to run with the arguments %p, with its usage',
  (args) => {
    const result = Bun.spawnSync([
      'bash',
      new URL('imp-host-dns-token.sh', import.meta.url).pathname,
      ...args,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toInclude('usage: imp-host-dns-token.sh SOURCE DIR');
  },
);
