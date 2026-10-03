import { expect, test } from 'bun:test';
import * as z from 'zod';
import { startFakeAgent } from '../agent-client/fake-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import type { InstallBundle } from '../broker/guest-trust';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { setupImpTest } from './test-imps';

// An exec with `require: ['broker']` starts only once impd set the broker's
// variables and the CA bundle for the boot it starts in.

const ExecFrameSchema = z.looseObject({
  op: z.string(),
  env: z.array(z.string()).optional(),
  session: z.string().optional(),
});

const RefusalSchema = z.object({
  code: z.literal('PRECONDITION_FAILED'),
  data: z.object({ reason: z.literal('broker_not_ready'), detail: z.string() }),
});

// the detail of a broker refusal; anything else fails the test
async function readRefusal(opening: Promise<{ readonly close: () => void }>): Promise<string> {
  try {
    const stream = await opening;

    stream.close();
  } catch (error) {
    return RefusalSchema.parse(error).data.detail;
  }

  throw new Error('the exec started');
}

async function setupRequireTest(installBundle?: InstallBundle) {
  const options = installBundle === undefined ? {} : { installBundle };

  const ctx = await setupImpTest(options);

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  // the sessions the fake agent runs: a start with a new name creates one,
  // a start with a known name attaches
  const sessions = new Set<string>();

  // every exec the agent got, which answers each with STARTED
  const agent = await startFakeAgent(paths.vsockSocket, (socket, request) => {
    const session = ExecFrameSchema.parse(decodeJsonPayload(request)).session;
    const created = session !== undefined && !sessions.has(session);

    if (session !== undefined) {
      sessions.add(session);
    }

    socket.write(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 9,
        ...(session !== undefined && { session, created }),
      }),
    );
  });

  const createGrant = async () => {
    await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
    await ctx.broker.addGrant('dev', 'gh');
  };

  const readExecs = () =>
    agent.received.map((frame) => ExecFrameSchema.parse(decodeJsonPayload(frame)));

  return {
    ...ctx,
    paths,
    createGrant,
    readExecs,
    async [Symbol.asyncDispose]() {
      agent.close();

      await ctx[Symbol.asyncDispose]();
    },
  };
}

const REQUIRED = { argv: ['true'], tty: false, require: ['broker'] } as const;

test('without a grant, an exec that requires the broker starts nothing', async () => {
  await using ctx = await setupRequireTest();

  const refused = await readRefusal(ctx.imps.openExec('dev', REQUIRED));

  expect(refused).toContain('no grant');
  expect(ctx.readExecs()).toEqual([]);

  // the same exec without the requirement runs as before
  const stream = await ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  stream.close();

  expect(ctx.readExecs()).toHaveLength(1);
});

test('a failed CA bundle step refuses the exec, and the next exec tries it again', async () => {
  const state = { fail: true };

  await using ctx = await setupRequireTest(() =>
    state.fail ? Promise.reject(new Error('no /bin/sh')) : Promise.resolve(),
  );

  await ctx.createGrant();

  const refused = await readRefusal(ctx.imps.openExec('dev', REQUIRED));

  expect(refused).toContain('no /bin/sh');
  expect(ctx.readExecs()).toEqual([]);

  state.fail = false;

  const stream = await ctx.imps.openExec('dev', REQUIRED);

  stream.close();

  expect(ctx.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');

  // the requirement is impd's to check, not the agent's
  expect(ctx.readExecs()[0]).not.toHaveProperty('require');
});

test('the bundle step runs before the first exec of a boot, and again after a reboot', async () => {
  await using ctx = await setupRequireTest();

  await ctx.createGrant();

  const first = await ctx.imps.openExec('dev', REQUIRED);

  first.close();

  expect(ctx.bundleInstalls).toHaveLength(1);

  const env = ctx.readExecs()[0]?.env;

  expect(env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
  expect(env).toContain('SSL_CERT_FILE=/etc/imp/broker-ca.pem');

  // a restore halts the guest and boots it again: a new boot
  await ctx.imps.lockImp('dev', async (imp) => {
    const halted = await ctx.imps.haltImp(imp, false);

    await ctx.imps.bootImp(halted);
  });

  const second = await ctx.imps.openExec('dev', REQUIRED);

  second.close();

  expect(ctx.bundleInstalls).toHaveLength(2);
});

test('an env that replaces a broker variable is refused, and names it', async () => {
  await using ctx = await setupRequireTest();

  await ctx.createGrant();

  const refused = await readRefusal(
    ctx.imps.openExec('dev', { ...REQUIRED, env: ['SSL_CERT_FILE=/tmp/mine.pem'] }),
  );

  expect(refused).toContain('SSL_CERT_FILE');
  expect(ctx.readExecs()).toEqual([]);

  // a variable the broker does not set is the caller's to give
  const stream = await ctx.imps.openExec('dev', { ...REQUIRED, env: ['TERM=xterm'] });

  stream.close();

  expect(ctx.readExecs()).toHaveLength(1);
});

test('an outer exec never meets the broker requirement', async () => {
  await using ctx = await setupRequireTest();

  await ctx.createGrant();

  const refused = await readRefusal(
    ctx.imps.openExec('dev', { ...REQUIRED, outer: true }, 'outer-exec'),
  );

  expect(refused).toContain('in the agent');
  expect(ctx.readExecs()).toEqual([]);
});

test('no lifecycle operation runs between the bundle step and the start', async () => {
  const install: { release: () => void; reached: () => void } = {
    release: () => {},
    reached: () => {},
  };

  const reached = new Promise<void>((resolve) => {
    install.reached = resolve;
  });

  await using ctx = await setupRequireTest(
    () =>
      new Promise<void>((resolve) => {
        install.release = resolve;

        install.reached();
      }),
  );

  await ctx.createGrant();

  const order: string[] = [];

  const exec = (async () => {
    const stream = await ctx.imps.openExec('dev', REQUIRED);

    order.push(`exec started (${String(ctx.readExecs().length)} sent)`);
    stream.close();
  })();

  await reached;

  // as a restore would: it must wait for the exec to start
  const locked = ctx.imps.lockImp('dev', () => {
    order.push('lifecycle');

    return Promise.resolve();
  });

  await Bun.sleep(20);

  expect(order).toEqual([]);

  install.release();

  await Promise.all([exec, locked]);

  expect(order).toEqual(['exec started (1 sent)', 'lifecycle']);
});

test('a stop that takes the lock first leaves the exec to boot the imp and check again', async () => {
  await using ctx = await setupRequireTest();

  await ctx.createGrant();

  const order: string[] = [];

  // the exec finds the imp running, then the stop takes the lock before
  // the exec's bundle step does
  const opening = ctx.imps.openExec('dev', REQUIRED);

  const stopping = ctx.imps.lockImp('dev', async (imp) => {
    await ctx.imps.haltImp(imp, false);

    order.push('stopped');
  });

  const stream = await opening;

  stream.close();

  await stopping;

  expect(order).toEqual(['stopped']);
  expect(ctx.bundleInstalls).toHaveLength(1);
  expect(ctx.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
});

test('an attach that requires the broker passes only to a session started with it', async () => {
  await using ctx = await setupRequireTest();

  const identity = readVmIdentity(ctx.paths);

  if (identity === null) {
    throw new Error('no vm identity');
  }

  writeVmIdentity(ctx.paths, { ...identity, agentVersion: '0.16.0' });

  const start = (session: string, required: boolean) =>
    ctx.imps.openExec('dev', {
      argv: ['sh'],
      tty: true,
      session,
      ...(required && { require: ['broker'] as const }),
    });

  const ungranted = await readRefusal(start('main', true));

  expect(ungranted).toContain('no grant');
  expect(ctx.readExecs()).toEqual([]);

  await ctx.createGrant();

  // started with the requirement, then attached to with it
  for (const opening of [start('main', true), start('main', true)]) {
    const stream = await opening;

    stream.close();
  }

  // started without it: an attach that requires the broker is refused
  const plain = await start('other', false);

  plain.close();

  const refused = await readRefusal(start('other', true));

  expect(refused).toBe('session other was started without the broker requirement');
});
