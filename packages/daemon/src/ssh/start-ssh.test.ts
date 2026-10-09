import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { Client } from 'ssh2';
import { createApiAudit } from '../audit/api-audit';
import { createRevocations } from '../auth/revocations';
import { createImage } from '../db/images';
import { createImp } from '../db/imps';
import { buildStubSshBackend } from '../test-utils/build-stub-ssh-backend';
import { createTestDatabase } from '../test-utils/create-test-database';
import { openSshClient } from '../test-utils/open-ssh-client';
import { createAuthorizedKeys } from './authorized-keys';
import { createEd25519Key, readFingerprint } from './host-key';
import { startSsh } from './start-ssh';

// impd's data dir with an owner-only ssh/ the test fills, its database, and
// the deps startSsh takes besides the config
async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'imp-start-ssh-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const sshDir = join(dataDir, 'ssh');

  const database = await createTestDatabase();

  const logs: string[] = [];

  mkdirSync(sshDir, { mode: 0o700 });

  return {
    dataDir,
    sshDir,
    db: database.db,
    logs,
    deps: {
      audit: createApiAudit({ db: database.db, now: Date.now, log: () => {} }),
      db: database.db,
      authorizedKeys: createAuthorizedKeys(join(sshDir, 'authorized_keys'), () => {}),
      tokens: { findSshKey: () => null },
      revocations: createRevocations(),
      imps: buildStubSshBackend().backend,
      log: (message: string) => {
        logs.push(message);
      },
      now: Date.now,
    },
  };
}

test('it makes a host key and logs the port and the key’s fingerprint', async () => {
  const ctx = await setupTest();

  const gateway = await startSsh({
    ...ctx.deps,
    config: { dataDir: ctx.dataDir, sshPort: 0, sshAuthorizedKeys: true },
  });

  invariant(gateway);
  onTestFinished(() => gateway.stop());

  const fingerprint = readFingerprint(readFileSync(join(ctx.sshDir, 'host_key'), 'utf8'));

  expect(ctx.logs).toStrictEqual([
    `impd: ssh on :${String(gateway.port)}, host key ${fingerprint}`,
  ]);
});

test('it starts no gateway when IMP_SSH_PORT turns it off', async () => {
  const ctx = await setupTest();

  const gateway = await startSsh({
    ...ctx.deps,
    config: { dataDir: ctx.dataDir, sshPort: null, sshAuthorizedKeys: true },
  });

  expect(gateway).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});

// impd stays up for the API and the proxy, as without the gateway
test('it logs a corrupt host key and leaves the gateway off', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.sshDir, 'host_key'), 'garbage');

  const gateway = await startSsh({
    ...ctx.deps,
    config: { dataDir: ctx.dataDir, sshPort: 0, sshAuthorizedKeys: true },
  });

  expect(gateway).toBeNull();

  expect(ctx.logs).toStrictEqual([
    expect.toSatisfy((line: string) => /^impd: ssh: not started on :0: \S/v.test(line)),
  ]);
});

// a directory where the key file should be: reading it fails
test('it logs an unreadable host key and leaves the gateway off', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.sshDir, 'host_key'));

  const gateway = await startSsh({
    ...ctx.deps,
    config: { dataDir: ctx.dataDir, sshPort: 0, sshAuthorizedKeys: true },
  });

  expect(gateway).toBeNull();

  expect(ctx.logs).toStrictEqual([
    expect.toSatisfy((line: string) => /^impd: ssh: not started on :0: \S/v.test(line)),
  ]);
});

test('it logs a key from authorized_keys in to an imp in the database', async () => {
  const ctx = await setupTest();

  const key = createEd25519Key();

  // the image the imp row refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 2,
    memoryMib: 2048,
    slot: 0,
    ip: '10.66.0.2',
  });

  writeFileSync(join(ctx.sshDir, 'authorized_keys'), `${key.public}\n`, { mode: 0o600 });

  const gateway = await startSsh({
    ...ctx.deps,
    config: { dataDir: ctx.dataDir, sshPort: 0, sshAuthorizedKeys: true },
  });

  invariant(gateway);
  onTestFinished(() => gateway.stop());

  const login = openSshClient({
    host: '127.0.0.1',
    port: gateway.port,
    username: 'dev',
    privateKey: key.private,
  });

  const client = await login;

  expect(client).toBeInstanceOf(Client);
});

test('it refuses a key from authorized_keys when IMP_SSH_AUTHORIZED_KEYS is false', async () => {
  const ctx = await setupTest();

  const key = createEd25519Key();

  // the image the imp row refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 2,
    memoryMib: 2048,
    slot: 0,
    ip: '10.66.0.2',
  });

  writeFileSync(join(ctx.sshDir, 'authorized_keys'), `${key.public}\n`, { mode: 0o600 });

  const gateway = await startSsh({
    ...ctx.deps,
    config: { dataDir: ctx.dataDir, sshPort: 0, sshAuthorizedKeys: false },
  });

  invariant(gateway);
  onTestFinished(() => gateway.stop());

  const login = openSshClient({
    host: '127.0.0.1',
    port: gateway.port,
    username: 'dev',
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});
