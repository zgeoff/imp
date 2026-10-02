import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { findImp, readImpEnv, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { instance } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// Leases (docs/guides/leases.md): each owner's own hold on an imp, through
// the API as a client calls it; the CLI has no lease command.

const prefix = setupSuite('leases');
const dev = `${prefix}dev`;
const held = `${prefix}held`;

// token names, made and removed by this suite
const OWNER_A = `${prefix}a`;
const OWNER_B = `${prefix}b`;

// the refusal fills the budget, so it runs only with a small one
const MAX_REFUSAL_BUDGET_MIB = 2048;

const secrets = new Map<string, string>();

const LeaseSchema = z.object({
  name: z.string(),
  owner: z.object({ principal: z.string(), display: z.string(), label: z.string() }),
  until: z.string().nullable(),
});

const ProtectedSchema = z.object({ name: z.string(), leased: z.boolean() });
const ErrorSchema = z.object({ code: z.string(), data: z.unknown().optional() });

interface RpcAnswer {
  readonly ok: boolean;
  readonly body: unknown;
}

// a call to impd's API as `token`: the answer's `json`, or its error
async function sendRpc(token: string, path: string, input: unknown): Promise<RpcAnswer> {
  const response = await fetch(`${instance.apiUrl}/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(60_000),
  });

  const raw: unknown = await response.json();

  const answer = z.object({ json: z.unknown() }).parse(raw);

  return { ok: response.ok, body: answer.json };
}

async function requireRpc(token: string, path: string, input: unknown): Promise<unknown> {
  const answer = await sendRpc(token, path, input);

  if (!answer.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(answer.body)}`);
  }

  return answer.body;
}

async function readRpcRefusal(token: string, path: string, input: unknown) {
  const answer = await sendRpc(token, path, input);

  expect(answer.ok).toBeFalse();

  return ErrorSchema.parse(answer.body);
}

async function listLeases(token: string, input: object = {}) {
  const body = await requireRpc(token, 'leases/list', input);

  return z.array(LeaseSchema).parse(body);
}

// `imp token new`, which prints the secret alone on stdout
async function makeToken(name: string): Promise<string> {
  await tryImp(['token', 'rm', name]);

  const stdout = await runImp('token', 'new', name, '--scope', 'exec');

  const secret = stdout.trim();

  secrets.set(name, secret);

  return secret;
}

let root = '';
let ownerA = '';
let ownerB = '';

beforeAll(async () => {
  const env = await readImpEnv();

  root = env['IMP_TOKEN'] ?? '';

  ownerA = await makeToken(OWNER_A);
  ownerB = await makeToken(OWNER_B);

  const image = resolveImageName('e2e-tiny');

  await createImp(dev, '--image', image, '--memory', '256');
  await createImp(held, '--image', image, '--memory', '256');
}, 120_000);

afterAll(async () => {
  for (const name of secrets.keys()) {
    await tryImp(['token', 'rm', name]);
  }
});

test('impd says it has leases', async () => {
  const body = await requireRpc(root, 'system/info', {});

  const info = z.object({ features: z.object({ leases: z.boolean() }) }).parse(body);

  expect(info.features.leases).toBeTrue();
});

test('two owners lease one imp, and each sees and releases only its own', async () => {
  await requireRpc(ownerA, 'leases/acquire', { name: dev, label: 'job', ttlSeconds: 120 });
  await requireRpc(ownerB, 'leases/acquire', { name: dev, label: 'job', ttlSeconds: 120 });

  const seenByA = await listLeases(ownerA, { name: dev });
  const seenByRoot = await listLeases(root, { name: dev });
  const got = await requireRpc(ownerA, 'imps/get', { name: dev });

  const impForA = z
    .object({ leases: z.object({ leases: z.array(LeaseSchema), otherCount: z.int() }) })
    .parse(got);

  expect(seenByA.map((lease) => lease.owner.display)).toEqual([OWNER_A]);
  expect(seenByRoot.map((lease) => lease.owner.display).toSorted()).toEqual([OWNER_A, OWNER_B]);
  expect(impForA.leases.otherCount).toBe(1);

  const released = await requireRpc(ownerA, 'leases/release', { name: dev, label: 'job' });
  const left = await listLeases(root, { name: dev });

  expect(released).toEqual({ released: true });
  expect(left.map((lease) => lease.owner.display)).toEqual([OWNER_B]);

  await requireRpc(ownerB, 'leases/release', { name: dev, label: 'job' });
});

test('a sleep of a leased imp fails with LEASED; imp sleep forces it and ends the lease', async () => {
  await requireRpc(ownerA, 'leases/acquire', { name: dev, label: 'job', ttlSeconds: 300 });

  const forB = await readRpcRefusal(ownerB, 'imps/sleep', { name: dev });
  const forA = await readRpcRefusal(ownerA, 'imps/stop', { name: dev });

  expect(forB).toMatchObject({ code: 'LEASED', data: { leases: [], otherCount: 1 } });

  expect(forA).toMatchObject({
    code: 'LEASED',
    data: { leases: [{ owner: { display: OWNER_A, label: 'job' } }], otherCount: 0 },
  });

  // the CLI passes force: a person typed it
  await runImp('sleep', dev);

  const renew = await readRpcRefusal(ownerA, 'leases/renew', {
    name: dev,
    label: 'job',
    ttlSeconds: 60,
  });

  const imp = await findImp(dev);

  expect(renew.code).toBe('LEASE_NOT_HELD');
  expect(imp?.state).toBe('sleeping');
});

test('an acquire wakes the imp; past its end the lease is gone and the imp idles to sleep', async () => {
  await requireRpc(ownerA, 'leases/acquire', { name: dev, label: 'short', ttlSeconds: 10 });

  const awake = await findImp(dev);

  expect(awake?.state).toBe('running');

  await waitFor(
    'the lease to end',
    async () => {
      const leases = await listLeases(ownerA, { name: dev });

      expect(leases).toEqual([]);
    },
    { timeoutMs: 20_000 },
  );

  const renew = await readRpcRefusal(ownerA, 'leases/renew', {
    name: dev,
    label: 'short',
    ttlSeconds: 60,
  });

  expect(renew.code).toBe('LEASE_NOT_HELD');

  await waitFor(
    `${dev} to sleep once idle`,
    async () => {
      const imp = await findImp(dev);

      expect(imp?.state).toBe('sleeping');
    },
    { timeoutMs: (config.idleTimeoutS + 30) * 1000 },
  );
});

test('a sleep without force of a held imp still sleeps it, and the hold survives', async () => {
  await runImp('hold', held, '30m');

  const slept = await requireRpc(ownerB, 'imps/sleep', { name: held });

  const asleep = z.object({ state: z.string(), holdUntil: z.string() }).parse(slept);

  expect(asleep.state).toBe('sleeping');
  expect(Date.parse(asleep.holdUntil)).toBeGreaterThan(Date.now() + 25 * 60_000);

  await runImp('hold', held, '0');
});

test.skipIf(config.ramBudgetMib > MAX_REFUSAL_BUDGET_MIB)(
  'a refused acquire names the leased imps that hold the RAM, and keeps no lease',
  async () => {
    const budget = config.ramBudgetMib;
    const image = resolveImageName('e2e-tiny');

    // two leased imps own over half the budget; a cold boot reserves half
    // of the third's memory, the whole budget
    const fillMib = Math.floor(budget / 4) + 64;
    const fillers = [`${prefix}fill-a`, `${prefix}fill-b`];
    const big = `${prefix}big`;

    // first, while the budget has room for its boot
    await createImp(big, '--image', image, '--memory', String(budget));
    await runImp('stop', big);

    for (const name of fillers) {
      await createImp(name, '--image', image, '--memory', String(fillMib + 192));
      await requireRpc(root, 'leases/acquire', { name, label: 'fill', ttlSeconds: 600 });

      await runShellInImp(
        name,
        `mkdir -p /run/fill && mount -t tmpfs -o size=${String(fillMib + 16)}m tmpfs /run/fill && ` +
          `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(fillMib)} 2>/dev/null`,
      );
    }

    const refused = await readRpcRefusal(ownerA, 'leases/acquire', {
      name: big,
      label: 'job',
      ttlSeconds: 60,
    });

    const leases = await listLeases(root, { name: big });

    expect(refused).toMatchObject({
      code: 'RAM_BUDGET_EXCEEDED',
      data: { budgetMib: budget, protectedHidden: 0 },
    });

    const data = z
      .object({
        neededMib: z.int().positive(),
        protected: z.array(ProtectedSchema),
      })
      .parse(refused.data);

    const leased = data.protected.filter((imp) => imp.leased).map((imp) => imp.name);

    expect(leased.toSorted()).toEqual(fillers);
    expect(leases).toEqual([]);

    console.log(
      `    refused: ${String(data.neededMib)} MiB short of ${String(budget)} MiB; protected ${data.protected.map((imp) => imp.name).join(', ')}`,
    );
  },
  180_000,
);
