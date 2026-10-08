import { expect, mock, onTestFinished, test } from 'bun:test';
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
import { UsageError } from './usage-error';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-hosts-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env = { XDG_CONFIG_HOME: dir };

  return { env, path: resolveConfigPath(env) };
}

test('#readHostConfig reads no hosts when there is no config file', () => {
  const ctx = setupTest();

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('#writeHostConfig writes mode 0600 in a 0700 directory that holds only the config', () => {
  const ctx = setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'secret' } },
  });

  expect(statSync(ctx.path).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.path, '..')).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(ctx.path, '..'))).toStrictEqual(['config.json']);
});

test('#readHostConfig reads back the hosts a write saved', () => {
  const ctx = setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'secret' } },
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'secret' } },
  });
});

test('#writeHostConfig keeps mode 0600 over a stale temp file of another mode', () => {
  const ctx = setupTest();

  writeHostConfig(ctx.env, { current: 'home', hosts: {} });
  writeFileSync(`${ctx.path}.${String(process.pid)}.tmp`, 'stale', { mode: 0o644 });
  writeHostConfig(ctx.env, { current: null, hosts: {} });

  expect(statSync(ctx.path).mode & 0o777).toBe(0o600);
});

test('#writeHostConfig writes through a symlinked config.json and keeps the link', () => {
  const ctx = setupTest();
  const target = join(ctx.path, '..', '..', 'dotfiles-config.json');

  mkdirSync(join(ctx.path, '..'), { recursive: true });
  writeFileSync(target, '{}', { mode: 0o600 });
  symlinkSync(target, ctx.path);

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'secret' } },
  });

  expect(lstatSync(ctx.path).isSymbolicLink()).toBeTrue();

  expect(readHostConfig({ XDG_CONFIG_HOME: join(ctx.path, '..', '..') })).toStrictEqual({
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'secret' } },
  });
});

test('#writeHostConfig rethrows a failure to resolve the config path other than a missing file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.path, '..'), { recursive: true });
  symlinkSync(ctx.path, ctx.path);

  expect(() => {
    writeHostConfig(ctx.env, { current: null, hosts: {} });
  }).toThrow(expect.objectContaining({ code: 'ELOOP' }));
});

test('#readHostConfig warns when others can read the file', () => {
  const ctx = setupTest();
  const warn = mock<(line: string) => void>();

  writeHostConfig(ctx.env, { current: null, hosts: {} });
  chmodSync(ctx.path, 0o644);
  readHostConfig(ctx.env, warn);

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    `imp: warning: ${ctx.path} is readable by other users; run chmod 600 ${ctx.path}`,
  );
});

test('#readHostConfig leaves the mode of a file others can read as it is', () => {
  const ctx = setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: {} });
  chmodSync(ctx.path, 0o644);

  readHostConfig(ctx.env, () => {
    // the warning has a test of its own
  });

  expect(statSync(ctx.path).mode & 0o777).toBe(0o644);
});

test('#readHostConfig rejects a file that is not valid JSON', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.path, '..'), { recursive: true });
  writeFileSync(ctx.path, '{', { mode: 0o600 });

  expect(() => readHostConfig(ctx.env)).toThrowWithMessage(
    UsageError,
    `${ctx.path} is not valid JSON; fix or remove it`,
  );
});

test('#readHostConfig rejects JSON that is not an imp config', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.path, '..'), { recursive: true });
  writeFileSync(ctx.path, JSON.stringify({ hosts: { home: { url: 1 } } }), { mode: 0o600 });

  expect(() => readHostConfig(ctx.env)).toThrowWithMessage(
    UsageError,
    new RegExp(`^${ctx.path} is not an imp config \\(`, 'u'),
  );
});

test('#readHostConfig rethrows a read failure other than a missing file', () => {
  const ctx = setupTest();

  mkdirSync(ctx.path, { recursive: true });

  expect(() => readHostConfig(ctx.env)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
});

test('#checkHostName accepts one shell word', () => {
  expect(checkHostName('work-2.lab')).toBe('work-2.lab');
});

test.each([['https://imp.example'], [''], ['-x']])(
  '#checkHostName rejects %p as a host name',
  (name) => {
    expect(() => checkHostName(name)).toThrowWithMessage(
      UsageError,
      `not a host name: ${name} (letters, digits, '.', '_' and '-'; a URL goes to imp login)`,
    );
  },
);
