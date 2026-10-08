import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_FILE,
  createRegistryTrust,
  removeStaleRegistryTrusts,
} from './create-registry-trust';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'registry-trust-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const certPath = join(dir, 'cert.pem');

  // the registry's certificate as openssl writes it
  await writeFile(certPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');

  return { dir, certPath, certsRoot: join(dir, 'certs.d') };
}

test('#createRegistryTrust trusts the certificate in a directory named for the registry', async () => {
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

test('#createRegistryTrust refuses a registry whose directory is already there, and leaves it as it was', async () => {
  const ctx = await setupTest();

  const owned = join(ctx.certsRoot, 'imp-e2e-registry.test:43210');

  await mkdir(owned, { recursive: true });
  await writeFile(join(owned, 'ca.crt'), 'another owner');

  const attempt = createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  // settled before the directory is read
  await Promise.allSettled([attempt]);

  expect(attempt).rejects.toThrow(/^refusing to trust imp-e2e-registry\.test:43210: mkdir: /);

  const kept = await readFile(join(owned, 'ca.crt'), 'utf8');

  expect(kept).toBe('another owner');
});

test('#createRegistryTrust removes the directory it made', async () => {
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

test('#createRegistryTrust never removes the certs root, nor another registry in it', async () => {
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

test('#createRegistryTrust removes once, so a directory made again after the removal stays', async () => {
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

test('#createRegistryTrust removes the directory it made when the certificate copy fails', async () => {
  const ctx = await setupTest();

  const attempt = createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: join(ctx.dir, 'missing.pem'),
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  // settled before the directory is read
  await Promise.allSettled([attempt]);

  expect(attempt).rejects.toThrow(/^cp .* exited 1: /);

  const left = await readdir(ctx.certsRoot);

  expect(left).toBeEmpty();
});

test('#createRegistryTrust writes an owner file with this process’s pid and start time', async () => {
  const ctx = await setupTest();

  // this process's stat, whose 22nd field is its start time
  const procRoot = join(ctx.dir, 'proc');

  await mkdir(join(procRoot, String(process.pid)), { recursive: true });

  await writeFile(
    join(procRoot, String(process.pid), 'stat'),
    `${String(process.pid)} (bun test) S ${Array.from({ length: 18 }, () => '0').join(' ')} 4242 0\n`,
  );

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
    procRoot,
  });

  const text = await readFile(join(trust.dir, OWNER_FILE), 'utf8');

  const owner: unknown = JSON.parse(text);

  expect(owner).toStrictEqual({ pid: process.pid, startTime: '4242' });
});

test('#createRegistryTrust makes nothing when this process’s start time is unreadable', async () => {
  const ctx = await setupTest();

  const procRoot = join(ctx.dir, 'proc');

  await mkdir(procRoot);

  const attempt = createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
    procRoot,
  });

  await Promise.allSettled([attempt]);

  expect(attempt).rejects.toThrow(
    "refusing to trust imp-e2e-registry.test:43210: this process's start time is unreadable",
  );

  expect(existsSync(ctx.certsRoot)).toBeFalse();
});

test('#createRegistryTrust takes over the directory an exited run of this harness left', async () => {
  const ctx = await setupTest();

  const gone = Bun.spawn(['true']);

  await gone.exited;

  const stale = join(ctx.certsRoot, 'imp-e2e-registry.test:43210');

  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, 'ca.crt'), 'an earlier run');
  await writeFile(join(stale, OWNER_FILE), JSON.stringify({ pid: gone.pid, startTime: '1' }));

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  const trusted = await readFile(join(trust.dir, 'ca.crt'), 'utf8');

  expect(trusted).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
});

test('#createRegistryTrust removes what exited runs left on other ports of the same host', async () => {
  const ctx = await setupTest();

  const gone = Bun.spawn(['true']);

  await gone.exited;

  const stale = join(ctx.certsRoot, 'imp-e2e-registry.test:40001');

  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, OWNER_FILE), JSON.stringify({ pid: gone.pid, startTime: '1' }));

  await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  const left = await readdir(ctx.certsRoot);

  expect(left).toStrictEqual(['imp-e2e-registry.test:43210']);
});

test('#removeStaleRegistryTrusts removes a directory whose owner no longer runs', async () => {
  const ctx = await setupTest();

  const gone = Bun.spawn(['true']);

  await gone.exited;

  const stale = join(ctx.certsRoot, 'imp-e2e-registry.test:40001');

  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, OWNER_FILE), JSON.stringify({ pid: gone.pid, startTime: '1' }));

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toStrictEqual([stale]);
  expect(existsSync(stale)).toBeFalse();
});

test('#removeStaleRegistryTrusts keeps a directory whose owner still runs', async () => {
  const ctx = await setupTest();

  const trust = await createRegistryTrust({
    registry: 'imp-e2e-registry.test:43210',
    certPath: ctx.certPath,
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toBeEmpty();
  expect(existsSync(trust.dir)).toBeTrue();
});

test('#removeStaleRegistryTrusts removes a directory whose pid now runs another process', async () => {
  const ctx = await setupTest();

  // this process's pid, with a start time it never had: the pid was reused
  const reused = join(ctx.certsRoot, 'imp-e2e-registry.test:40004');

  await mkdir(reused, { recursive: true });
  await writeFile(join(reused, OWNER_FILE), JSON.stringify({ pid: process.pid, startTime: '1' }));

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toStrictEqual([reused]);
  expect(existsSync(reused)).toBeFalse();
});

test('#removeStaleRegistryTrusts keeps a directory whose owner file records no start time', async () => {
  const ctx = await setupTest();

  const gone = Bun.spawn(['true']);

  await gone.exited;

  const unproven = join(ctx.certsRoot, 'imp-e2e-registry.test:40005');

  await mkdir(unproven, { recursive: true });
  await writeFile(join(unproven, OWNER_FILE), JSON.stringify({ pid: gone.pid, startTime: null }));

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toBeEmpty();
  expect(existsSync(unproven)).toBeTrue();
});

test('#removeStaleRegistryTrusts keeps a directory with no owner file', async () => {
  const ctx = await setupTest();

  const unowned = join(ctx.certsRoot, 'imp-e2e-registry.test:40002');

  await mkdir(unowned, { recursive: true });
  await writeFile(join(unowned, 'ca.crt'), 'another owner');

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toBeEmpty();
  expect(existsSync(unowned)).toBeTrue();
});

test('#removeStaleRegistryTrusts keeps a directory whose owner file does not parse', async () => {
  const ctx = await setupTest();

  const garbled = join(ctx.certsRoot, 'imp-e2e-registry.test:40003');

  await mkdir(garbled, { recursive: true });
  await writeFile(join(garbled, OWNER_FILE), 'not json');

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toBeEmpty();
  expect(existsSync(garbled)).toBeTrue();
});

test('#removeStaleRegistryTrusts never looks at another registry name', async () => {
  const ctx = await setupTest();

  const other = join(ctx.certsRoot, 'registry.example:5000');

  await mkdir(other, { recursive: true });
  await writeFile(join(other, OWNER_FILE), JSON.stringify({ pid: 1, startTime: 'gone' }));

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toBeEmpty();
  expect(existsSync(other)).toBeTrue();
});

test('#removeStaleRegistryTrusts removes nothing when the certs root does not exist', async () => {
  const ctx = await setupTest();

  const removed = await removeStaleRegistryTrusts({
    name: 'imp-e2e-registry.test',
    certsRoot: ctx.certsRoot,
    asRoot: [],
  });

  expect(removed).toBeEmpty();
});
