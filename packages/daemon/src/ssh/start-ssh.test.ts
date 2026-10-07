import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiAudit } from '../audit/api-audit';
import { createRevocations } from '../auth/revocations';
import { setupTestDatabase } from '../test-utils/create-test-database';
import { createAuthorizedKeys } from './authorized-keys';
import { createFakeSshBackend } from './fake-ssh-backend';
import { startSsh } from './start-ssh';

// impd with a data directory whose ssh/ the test sets up first
async function startWithSshDir(setup: (sshDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-start-ssh-'));
  const sshDir = join(dataDir, 'ssh');
  const logs: string[] = [];

  await using database = await setupTestDatabase();

  mkdirSync(sshDir, { mode: 0o700 });
  setup(sshDir);

  try {
    const gateway = await startSsh({
      audit: createApiAudit({ db: database.db, now: Date.now, log: () => {} }),
      config: { dataDir, sshPort: 0, sshAuthorizedKeys: true },
      db: database.db,
      authorizedKeys: createAuthorizedKeys(join(sshDir, 'authorized_keys'), () => {}),
      tokens: { findSshKey: () => null },
      revocations: createRevocations(),
      imps: createFakeSshBackend().backend,
      log: (message) => {
        logs.push(message);
      },
      now: Date.now,
    });

    await gateway?.stop();

    return { started: gateway !== null, logs };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('it makes a host key and listens', async () => {
  const result = await startWithSshDir(() => {});

  expect(result.started).toBeTrue();
  expect(result.logs.join('\n')).toMatch(/impd: ssh on :\d+, host key SHA256:/);
});

function writeCorruptKey(sshDir: string): void {
  writeFileSync(join(sshDir, 'host_key'), 'garbage');
}

// a directory where the key file should be: reading it fails
function createKeyDirectory(sshDir: string): void {
  mkdirSync(join(sshDir, 'host_key'));
}

// impd stays up for the API and the proxy, as without the gateway
test.each([
  ['a corrupt host key', writeCorruptKey],
  ['an unreadable host key', createKeyDirectory],
])('%s is logged and the gateway stays off', async (_case, setup) => {
  const result = await startWithSshDir(setup);

  expect(result.started).toBeFalse();
  expect(result.logs).toHaveLength(1);
  expect(result.logs[0]).toStartWith('impd: ssh: not started on :0: ');
});
