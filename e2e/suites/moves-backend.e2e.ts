import { expect, test } from 'bun:test';
import { readInfo } from '../lib/imp-cli';
import { readMoveHosts } from '../lib/move-hosts';

// Both hosts on the run's backend, before any move: the moves then send what
// that pair sends, files from XFS and `zfs send` streams between two ZFS
// hosts, so a ZFS run cannot fall back to files unseen.

// the hosts the harness's fixture keeps up for the suite
function setupTest() {
  const hosts = readMoveHosts({ tailnet: false });

  return { hosts };
}

test('it runs both hosts on the storage backend the run asked for', async () => {
  const ctx = setupTest();
  const backend = process.env['IMP_STORAGE_BACKEND'] === 'zfs' ? 'zfs' : 'xfs';

  const infoA = await readInfo(ctx.hosts.a);
  const infoB = await readInfo(ctx.hosts.b);

  expect(infoA.storage.backend).toBe(backend);
  expect(infoB.storage.backend).toBe(backend);
});
