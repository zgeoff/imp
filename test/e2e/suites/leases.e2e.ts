import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '../../../packages/client/src/index';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, findImp, runImp, runShellInImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { instance } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeTokenIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// Leases (docs/guides/leases.md): each owner's own hold on an imp, through
// the API as a client calls it; the CLI has no lease command. Each owner is
// an exec-scoped token the test makes.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('leases'), stack, client };
}

test('it reports the leases feature', async () => {
  const ctx = await setupTest();
  const info = await ctx.client.system.info();

  expect(info.features?.leases).toBeTrue();
});

test('it lets two owners lease one imp, each seeing and releasing only its own', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}two`;
  const ownerA = `${ctx.prefix}a`;
  const ownerB = `${ctx.prefix}b`;

  const tokenA = await ctx.client.tokens.create({ name: ownerA, scope: 'exec' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, ownerA));

  const tokenB = await ctx.client.tokens.create({ name: ownerB, scope: 'exec' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, ownerB));

  const clientA = createImpClient({ url: instance.apiUrl, token: tokenA.secret });
  const clientB = createImpClient({ url: instance.apiUrl, token: tokenB.secret });

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  await clientA.leases.acquire({ name, label: 'job', ttlSeconds: 120 });
  await clientB.leases.acquire({ name, label: 'job', ttlSeconds: 120 });

  const seenByA = await clientA.leases.list({ name });
  const seenByRoot = await ctx.client.leases.list({ name });
  const impForA = await clientA.imps.get({ name });

  expect(seenByA.map((lease) => lease.owner.display)).toStrictEqual([ownerA]);
  expect(seenByRoot.map((lease) => lease.owner.display).toSorted()).toStrictEqual([ownerA, ownerB]);
  expect(impForA.leases?.otherCount).toBe(1);

  const released = await clientA.leases.release({ name, label: 'job' });
  const left = await ctx.client.leases.list({ name });

  expect(released).toStrictEqual({ released: true });
  expect(left.map((lease) => lease.owner.display)).toStrictEqual([ownerB]);
});

test('it refuses a sleep or stop of a leased imp with LEASED, and imp sleep forces it and ends the lease', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}leased`;
  const ownerA = `${ctx.prefix}leased-a`;
  const ownerB = `${ctx.prefix}leased-b`;

  const tokenA = await ctx.client.tokens.create({ name: ownerA, scope: 'exec' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, ownerA));

  const tokenB = await ctx.client.tokens.create({ name: ownerB, scope: 'exec' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, ownerB));

  const clientA = createImpClient({ url: instance.apiUrl, token: tokenA.secret });
  const clientB = createImpClient({ url: instance.apiUrl, token: tokenB.secret });

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  await clientA.leases.acquire({ name, label: 'job', ttlSeconds: 300 });

  expect(clientB.imps.sleep({ name })).rejects.toMatchObject({
    code: 'LEASED',
    data: { leases: [], otherCount: 1 },
  });

  expect(clientA.imps.stop({ name })).rejects.toMatchObject({
    code: 'LEASED',
    data: { leases: [{ owner: { display: ownerA, label: 'job' } }], otherCount: 0 },
  });

  // the CLI passes force: a person typed it
  await runImp('sleep', name);

  const imp = await findImp(name);

  expect(clientA.leases.renew({ name, label: 'job', ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });

  expect(imp?.state).toBe('sleeping');
});

test('it wakes the imp on an acquire, ends the lease at its end, and lets the imp idle to sleep', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}short`;
  const owner = `${ctx.prefix}short-a`;

  const token = await ctx.client.tokens.create({ name: owner, scope: 'exec' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, owner));

  const clientA = createImpClient({ url: instance.apiUrl, token: token.secret });

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImp('sleep', name);

  await clientA.leases.acquire({ name, label: 'short', ttlSeconds: 10 });

  const awake = await findImp(name);

  expect(awake?.state).toBe('running');

  await waitFor(
    'the lease to end',
    async () => {
      const leases = await clientA.leases.list({ name });

      if (leases.length > 0) {
        throw new Error(`${String(leases.length)} leases left`);
      }
    },
    { timeoutMs: 20_000 },
  );

  expect(clientA.leases.renew({ name, label: 'short', ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });

  const idle = await waitFor(
    `${name} to sleep once idle`,
    async () => {
      const imp = await findImp(name);

      if (imp?.state !== 'sleeping') {
        throw new Error(`${name} is ${imp?.state ?? 'gone'}`);
      }

      return imp;
    },
    { timeoutMs: (config.idleTimeoutS + 30) * 1000 },
  );

  expect(idle.state).toBe('sleeping');
});

test('it sleeps a held imp on a sleep without force, and the hold survives', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}held`;
  const owner = `${ctx.prefix}held-b`;

  const token = await ctx.client.tokens.create({ name: owner, scope: 'exec' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, owner));

  const clientB = createImpClient({ url: instance.apiUrl, token: token.secret });

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImp('hold', name, '30m');

  const slept = await clientB.imps.sleep({ name });

  expect(slept.state).toBe('sleeping');
  expect(slept.holdUntil?.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
});

// the refusal fills the budget, so it runs only with a small one
test.skipIf(config.ramBudgetMib > 2048)(
  'it refuses an acquire that needs the RAM leased imps hold, names them, and keeps no lease',
  async () => {
    const ctx = await setupTest();

    const budget = config.ramBudgetMib;
    const image = resolveImageName('e2e-tiny');
    const owner = `${ctx.prefix}big-a`;
    const big = `${ctx.prefix}big`;
    const fillA = `${ctx.prefix}fill-a`;
    const fillB = `${ctx.prefix}fill-b`;

    // two leased imps own over half the budget; a cold boot reserves half of
    // the third's memory, the whole budget
    const fillMib = Math.floor(budget / 4) + 64;

    const token = await ctx.client.tokens.create({ name: owner, scope: 'exec' });

    registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, owner));

    const clientA = createImpClient({ url: instance.apiUrl, token: token.secret });

    // first, while the budget has room for its boot
    await runImp('new', big, '--image', image, '--memory', String(budget));

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, big));

    await waitForExec(big);
    await runImp('stop', big);
    await runImp('new', fillA, '--image', image, '--memory', String(fillMib + 192));

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, fillA));

    await waitForExec(fillA);

    await ctx.client.leases.acquire({ name: fillA, label: 'fill', ttlSeconds: 600 });

    await runShellInImp(
      fillA,
      `mkdir -p /run/fill && mount -t tmpfs -o size=${String(fillMib + 16)}m tmpfs /run/fill && ` +
        `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(fillMib)} 2>/dev/null`,
    );

    await runImp('new', fillB, '--image', image, '--memory', String(fillMib + 192));

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, fillB));

    await waitForExec(fillB);

    await ctx.client.leases.acquire({ name: fillB, label: 'fill', ttlSeconds: 600 });

    await runShellInImp(
      fillB,
      `mkdir -p /run/fill && mount -t tmpfs -o size=${String(fillMib + 16)}m tmpfs /run/fill && ` +
        `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(fillMib)} 2>/dev/null`,
    );

    const acquired = clientA.leases.acquire({ name: big, label: 'job', ttlSeconds: 60 });

    // the two leased fillers, the only awake imps, are the protected imps it
    // names, each as leased
    expect(acquired).rejects.toMatchObject({
      code: 'RAM_BUDGET_EXCEEDED',
      data: {
        budgetMib: budget,
        protectedHidden: 0,
        neededMib: expect.toBePositive(),
        protected: expect.toIncludeSameMembers([
          { name: fillA, ramMib: expect.toBePositive(), leased: true, busy: expect.toBeBoolean() },
          { name: fillB, ramMib: expect.toBePositive(), leased: true, busy: expect.toBeBoolean() },
        ]),
      },
    });

    const leases = await ctx.client.leases.list({ name: big });

    expect(leases).toStrictEqual([]);
  },
  180_000,
);
