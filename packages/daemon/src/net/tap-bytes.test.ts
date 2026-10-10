import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuestNetBytes } from './tap-bytes';

async function setupTest() {
  const sys = await mkdtemp(join(tmpdir(), 'imp-sys-'));

  onTestFinished(() => rm(sys, { recursive: true, force: true }));

  return { sys };
}

test('it reads what the host receives on the tap as what the guest sent', async () => {
  const ctx = await setupTest();

  const statistics = join(ctx.sys, 'class', 'net', 'imp3', 'statistics');

  // the guest uploaded 5000 bytes and downloaded 70
  await mkdir(statistics, { recursive: true });
  await writeFile(join(statistics, 'rx_bytes'), '5000\n');
  await writeFile(join(statistics, 'tx_bytes'), '70\n');

  expect(readGuestNetBytes('imp3', ctx.sys)).toStrictEqual({ rxBytes: 70, txBytes: 5000 });
});

test('it reads no bytes for a tap that is gone', async () => {
  const ctx = await setupTest();

  expect(readGuestNetBytes('imp4', ctx.sys)).toBeNull();
});
