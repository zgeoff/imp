import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendClaim, sendPing } from '../agent-client/agent-requests';
import { startStubParkedAgent } from './start-stub-parked-agent';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-parked-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it answers a ping as a parked template guest a minute old', async () => {
  const ctx = await setupTest();

  await startStubParkedAgent(join(ctx.dir, 'v.sock'));

  const ping = await sendPing(join(ctx.dir, 'v.sock'));

  expect(ping).toStrictEqual({ ok: true, version: '0.1.0', uptime_ms: 60_000, stage: 'template' });
});

test('it answers a ping as a booted imp once claimed', async () => {
  const ctx = await setupTest();

  await startStubParkedAgent(join(ctx.dir, 'v.sock'));

  await sendClaim(join(ctx.dir, 'v.sock'), {
    id: 'i1',
    hostname: 'dev',
    ip: '10.66.0.2/30',
    gw: '10.66.0.1',
    ip6: null,
    gw6: null,
    dns: ['1.1.1.1'],
    mac: '06:00:0a:42:00:02',
    diskBytes: 0,
    unixMs: 0,
    seed: new Uint8Array(64),
    isIdentityReset: false,
  });

  const ping = await sendPing(join(ctx.dir, 'v.sock'));

  expect(ping.stage).toBeUndefined();
});
