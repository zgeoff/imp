import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstallInput, buildInstallScript, createGuestTrust } from './guest-trust';

const CA = '-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----';

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-trust-'));

  return {
    dir,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// the install script under sh, as the guest runs it, with paths in `dir`
function runInstall(dir: string, rootPaths: readonly string[]): string {
  const target = join(dir, 'imp', 'broker-ca.pem');

  const result = Bun.spawnSync(['sh', '-c', buildInstallScript(target, rootPaths)], {
    stdin: Buffer.from(buildInstallInput(CA)),
  });

  expect(result.exitCode).toBe(0);

  return readFileSync(target, 'utf8');
}

test("the bundle is the guest's own roots plus the broker CA", () => {
  using tmp = setupDir();

  const roots = join(tmp.dir, 'roots.pem');

  writeFileSync(roots, 'GUEST ROOTS, A CA THE GUEST ADDED INCLUDED\n');

  const bundle = runInstall(tmp.dir, [join(tmp.dir, 'missing.pem'), roots]);

  expect(bundle).toStartWith('GUEST ROOTS');
  expect(bundle).toContain(CA);
  expect(bundle).not.toContain('# imp: host roots');

  // the same bundle again leaves the file as it was
  const before = statSync(join(tmp.dir, 'imp', 'broker-ca.pem')).ino;

  runInstall(tmp.dir, [roots]);

  expect(statSync(join(tmp.dir, 'imp', 'broker-ca.pem')).ino).toBe(before);
});

test('a guest without roots gets the host roots', () => {
  using tmp = setupDir();

  const bundle = runInstall(tmp.dir, [join(tmp.dir, 'missing.pem')]);

  expect(bundle).toContain('-----BEGIN CERTIFICATE-----');
  expect(bundle.trimEnd()).toEndWith(CA);
  expect(bundle.split('BEGIN CERTIFICATE').length).toBeGreaterThan(50);
});

test('a failed install is tried again on the next exec, and a success is kept', async () => {
  const outcomes = [false, true];
  const calls: string[] = [];
  const logs: string[] = [];

  const trust = createGuestTrust(
    'input',
    (vsockPath) => {
      calls.push(vsockPath);

      return outcomes.shift() === true ? Promise.resolve() : Promise.reject(new Error('no sh'));
    },
    (message) => {
      logs.push(message);
    },
  );

  const imp = { id: 'imp-1', name: 'dev', pid: 7 };

  const first = await trust.ensure(imp, '/vsock');
  const second = await trust.ensure(imp, '/vsock');
  const third = await trust.ensure(imp, '/vsock');

  expect(first).toEqual({ installed: false, detail: 'no sh' });
  expect(second).toEqual({ installed: true });
  expect(third).toEqual(second);
  expect(calls).toHaveLength(2);
  expect(logs.join('\n')).toContain('no sh');
});

test('the same pid after a stop is a new boot, and installs again', async () => {
  const calls: string[] = [];

  const trust = createGuestTrust(
    'input',
    (vsockPath) => {
      calls.push(vsockPath);

      return Promise.resolve();
    },
    () => {},
  );

  const imp = { id: 'imp-1', name: 'dev', pid: 7 };

  const first = await trust.ensure(imp, '/vsock');

  trust.observe({ ...imp, state: 'running' });

  const same = await trust.ensure(imp, '/vsock');

  // the stop's write, then a boot that got pid 7 again
  trust.observe({ ...imp, pid: null, state: 'stopped' });
  trust.observe({ ...imp, state: 'running' });

  const again = await trust.ensure(imp, '/vsock');

  expect([first, same, again]).toEqual([
    { installed: true },
    { installed: true },
    { installed: true },
  ]);

  expect(calls).toHaveLength(2);
});
