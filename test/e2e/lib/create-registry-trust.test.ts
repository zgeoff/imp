import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistryTrust } from './create-registry-trust';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'registry-trust-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const certPath = join(dir, 'cert.pem');

  // the registry's certificate as openssl writes it
  await writeFile(certPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');

  return { dir, certPath, certsRoot: join(dir, 'certs.d') };
}

test('it trusts the certificate in a directory named for the registry', async () => {
  const ctx = await setupTest();

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  const trusted = await readFile(
    join(ctx.certsRoot, 'imp-e2e-registry.test:43210', 'ca.crt'),
    'utf8',
  );

  expect(trusted).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  expect(trust.dir).toBe(join(ctx.certsRoot, 'imp-e2e-registry.test:43210'));
});

test('it refuses a registry whose directory is already there, and leaves it as it was', async () => {
  const ctx = await setupTest();

  const owned = join(ctx.certsRoot, 'imp-e2e-registry.test:43210');

  await mkdir(owned, { recursive: true });
  await writeFile(join(owned, 'ca.crt'), 'another owner');

  expect(
    createRegistryTrust({
      registry: 'imp-e2e-registry.test:43210',
      certPath: ctx.certPath,
      certsRoot: ctx.certsRoot,
      asRoot: [],
    }),
  ).rejects.toThrow(/^refusing to trust imp-e2e-registry\.test:43210: mkdir: /);

  const kept = await readFile(join(owned, 'ca.crt'), 'utf8');

  expect(kept).toBe('another owner');
});

test('it removes the directory it made', async () => {
  const ctx = await setupTest();

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  await trust.remove();

  expect(existsSync(trust.dir)).toBeFalse();
});

test('it never removes the certs root, nor another registry in it', async () => {
  const ctx = await setupTest();

  const other = join(ctx.certsRoot, 'registry.example:5000');

  await mkdir(other, { recursive: true });

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  await trust.remove();

  const left = await readdir(ctx.certsRoot);

  expect(left).toStrictEqual(['registry.example:5000']);
});

test('it removes once, so a directory made again after the removal stays', async () => {
  const ctx = await setupTest();

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  await trust.remove();

  await mkdir(trust.dir);

  await trust.remove();

  expect(existsSync(trust.dir)).toBeTrue();
});

test('it removes the directory it made when the certificate copy fails', async () => {
  const ctx = await setupTest();

  expect(
    createRegistryTrust({
      registry: 'imp-e2e-registry.test:43210',
      certPath: join(ctx.dir, 'missing.pem'),
      certsRoot: ctx.certsRoot,
      asRoot: [],
    }),
  ).rejects.toThrow(/^cp .* exited 1: /);

  const left = await readdir(ctx.certsRoot);

  expect(left).toBeEmpty();
});
