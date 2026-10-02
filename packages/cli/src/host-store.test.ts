import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHostName, readHostConfig, resolveConfigPath, writeHostConfig } from './host-store';

afterEach(() => {
  mock.restore();
});

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-hosts-'));
  const env = { XDG_CONFIG_HOME: dir };

  return {
    env,
    path: resolveConfigPath(env),
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const CONFIG = {
  current: 'home',
  hosts: { home: { url: 'https://home.example', token: 'secret' } },
};

test('no config file reads as no hosts', () => {
  using ctx = setupTest();

  expect(readHostConfig(ctx.env)).toEqual({ current: null, hosts: {} });
});

test('it writes the config with mode 0600 in a 0700 directory, and reads it back', () => {
  using ctx = setupTest();

  writeHostConfig(ctx.env, CONFIG);

  expect(statSync(ctx.path).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.path, '..')).mode & 0o777).toBe(0o700);
  expect(readHostConfig(ctx.env)).toEqual(CONFIG);
  expect(readdirSync(join(ctx.path, '..'))).toEqual(['config.json']);
});

test('a rewrite keeps mode 0600 even over a stale temp file', () => {
  using ctx = setupTest();

  writeHostConfig(ctx.env, CONFIG);
  writeFileSync(`${ctx.path}.${String(process.pid)}.tmp`, 'stale', { mode: 0o644 });
  writeHostConfig(ctx.env, { ...CONFIG, current: null });

  expect(statSync(ctx.path).mode & 0o777).toBe(0o600);
  expect(readHostConfig(ctx.env).current).toBeNull();
});

test('a symlinked config.json stays a link, and the file it points at gets the write', () => {
  using ctx = setupTest();

  const target = join(ctx.path, '..', '..', 'dotfiles-config.json');

  mkdirSync(join(ctx.path, '..'), { recursive: true });
  writeFileSync(target, '{}', { mode: 0o600 });
  symlinkSync(target, ctx.path);
  writeHostConfig(ctx.env, CONFIG);

  expect(lstatSync(ctx.path).isSymbolicLink()).toBeTrue();
  expect(readHostConfig(ctx.env)).toEqual(CONFIG);
});

test('it warns when others can read the file, without changing it', () => {
  using ctx = setupTest();

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  writeHostConfig(ctx.env, CONFIG);
  chmodSync(ctx.path, 0o644);
  readHostConfig(ctx.env);

  expect(stderr).toHaveBeenCalledWith(
    `imp: warning: ${ctx.path} is readable by other users; run chmod 600 ${ctx.path}`,
  );

  expect(statSync(ctx.path).mode & 0o777).toBe(0o644);
});

test('a file that is not JSON or not a config is an error', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.path, '..'), { recursive: true });
  writeFileSync(ctx.path, '{', { mode: 0o600 });

  expect(() => readHostConfig(ctx.env)).toThrow(`${ctx.path} is not valid JSON; fix or remove it`);

  writeFileSync(ctx.path, JSON.stringify({ hosts: { home: { url: 1 } } }));

  expect(() => readHostConfig(ctx.env)).toThrow(`${ctx.path} is not an imp config`);
});

test('a host name is one shell word and never a URL', () => {
  expect(checkHostName('work-2.lab')).toBe('work-2.lab');
  expect(() => checkHostName('https://imp.example')).toThrow('not a host name');
  expect(() => checkHostName('')).toThrow('not a host name');
  expect(() => checkHostName('-x')).toThrow('not a host name');
});
