import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../test-utils/start-cli';
import { startStubImpd } from '../test-utils/start-stub-impd';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-db-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home, so no saved host of this machine reaches it
  const home = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { home, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

// an impd from before 0.30.0, which lacks the call
test('it makes no database copy on an impd older than 0.30.0', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'db-token',
    answers: {
      'system/info': { version: '0.26.0', features: { sessionOffsets: true, leases: true } },
    },
  });

  const result = await runCli({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'db-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd is older than 0.30.0 and would not know the call; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('it prints the database copy’s fields in the order a restore script reads them', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'db-token',
    answers: {
      'system/info': { version: '0.30.0', features: { databaseCopy: true } },
      'system/copyDatabase': {
        path: '/var/lib/imp/db-copies/before-upgrade.sqlite',
        sizeBytes: 4096,
        lastMigration: '030_x',
        impVersion: '0.30.0',
        createdAt: new Date('2026-10-04T00:00:00.000Z'),
        integrity: 'ok',
      },
    },
  });

  const result = await runCli({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'db-token' },
  });

  expect(result).toStrictEqual({
    stdout: `${JSON.stringify(
      {
        path: '/var/lib/imp/db-copies/before-upgrade.sqlite',
        sizeBytes: 4096,
        lastMigration: '030_x',
        impVersion: '0.30.0',
        createdAt: '2026-10-04T00:00:00.000Z',
        integrity: 'ok',
      },
      null,
      2,
    )}\n`,
    stderr: '',
    code: 0,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'system/copyDatabase']);
});
