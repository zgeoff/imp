import { expect, test } from 'bun:test';
import { removeImp } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { startWakeProxy } from './wake-proxy';

// free ports, away from a dev instance's
function pickPorts() {
  const base = 40_000 + Math.floor(Math.random() * 200) * 100;

  return {
    IMP_PROXY_PORT: String(base),
    IMP_PORT_BASE: String(base + 1),
    IMP_SUBNET: '10.99.0.0/24',
  };
}

async function isListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(500) });

    return true;
  } catch {
    return false;
  }
}

test('overlapping listener syncs end with the listeners the database holds', async () => {
  const ports = pickPorts();

  await using ctx = await setupImpTest({ env: ports });

  const proxy = startWakeProxy({ config: ctx.config, db: ctx.db, imps: ctx.imps, log: () => {} });

  try {
    await ctx.createTestImage('ubuntu');

    // a listener for `old`, then `old` goes and `new` takes its slot
    const old = await ctx.imps.createImp({ name: 'old' });

    await proxy.syncListeners();

    await removeImp(ctx.db, old.id);

    const fresh = await ctx.imps.createImp({ name: 'new' });

    // the first pass reads `new`, then waits on stopping old's listener; the
    // second reads after `new` is gone too
    const first = proxy.syncListeners();

    await removeImp(ctx.db, fresh.id);

    const second = proxy.syncListeners();

    await Promise.all([first, second]);

    const listening = await isListening(Number(ports.IMP_PORT_BASE) + fresh.slot);

    expect(listening).toBe(false);
  } finally {
    await proxy.stop();
  }
});
