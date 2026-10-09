import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { startStubSessionAgent } from '../test-utils/start-stub-session-agent';
import { createImpTest } from './test-imps';
import type { ImpTestOptions } from './test-imps';

// An exec with `require: ['broker']` starts only once impd set the broker's
// variables and the CA bundle for the boot it starts in.

// impd over the stub VMM with the CA install a test passes, and `stack`,
// whose releases (the agents a test starts) run before the harness's
async function setupTest(options: Pick<ImpTestOptions, 'installBundle'> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  // every create boots an image row; the default image is base
  await harness.createTestImage('base');

  return { ...harness, stack };
}

test('it refuses an exec that requires the broker without a grant', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the imp has no grant, so impd sets no broker variables',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it runs an exec without the requirement on an imp with no grant', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  const stream = await ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  stream.close();

  expect(agent.readExecs()).toHaveLength(1);
});

test('it refuses the exec when the CA bundle step fails', async () => {
  const ctx = await setupTest({ installBundle: () => Promise.reject(new Error('no /bin/sh')) });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the broker CA bundle is not in this boot of the guest: no /bin/sh',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it tries the CA bundle step again at the next exec after one failed', async () => {
  const install = { fail: true };

  const ctx = await setupTest({
    installBundle: () =>
      install.fail ? Promise.reject(new Error('no /bin/sh')) : Promise.resolve(),
  });

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

  install.fail = false;

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  expect(agent.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
});

test('it never sends the requirement to the agent', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  const [sent] = agent.readExecs();

  invariant(sent);

  expect(sent).not.toHaveProperty('require');
});

test('it runs the CA bundle step before the first exec of a boot, with the broker variables', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  const env = agent.readExecs()[0]?.env;

  expect(ctx.bundleInstalls).toHaveLength(1);
  expect(env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
  expect(env).toContain('SSL_CERT_FILE=/etc/imp/broker-ca.pem');
});

test('it runs the CA bundle step again after a reboot', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const first = await ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] });

  first.close();

  // a restore halts the guest and boots it again: a new boot
  await ctx.imps.lockImp('dev', async (locked) => {
    const halted = await ctx.imps.haltImp(locked, false);

    await ctx.imps.bootImp(halted);
  });

  const second = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  second.close();

  expect(ctx.bundleInstalls).toHaveLength(2);
});

test('it refuses an env that replaces a broker variable, and names it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', {
      argv: ['true'],
      tty: false,
      require: ['broker'],
      env: ['SSL_CERT_FILE=/tmp/mine.pem'],
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: "the exec's env sets SSL_CERT_FILE, which the broker sets",
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it passes an env variable the broker does not set', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
    env: ['TERM=xterm'],
  });

  stream.close();

  expect(agent.readExecs()[0]?.env).toContain('TERM=xterm');
});

test('it refuses the broker requirement for an outer exec', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec(
      'dev',
      { argv: ['true'], tty: false, require: ['broker'], outer: true },
      'outer-exec',
    ),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: { reason: 'broker_not_ready', detail: 'an exec in the agent gets no broker variables' },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it runs no lifecycle operation between the CA bundle step and the start', async () => {
  const install = { release: () => {}, reached: () => {} };

  const reached = new Promise<void>((resolve) => {
    install.reached = resolve;
  });

  const ctx = await setupTest({
    installBundle: () =>
      new Promise<void>((resolve) => {
        install.release = resolve;

        install.reached();
      }),
  });

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const order: string[] = [];

  const exec = (async () => {
    const stream = await ctx.imps.openExec('dev', {
      argv: ['true'],
      tty: false,
      require: ['broker'],
    });

    order.push(`exec started (${String(agent.readExecs().length)} sent)`);
    stream.close();
  })();

  await reached;

  // as a restore would: it queues on the lock the exec holds
  const locked = ctx.imps.lockImp('dev', () => {
    order.push('lifecycle');

    return Promise.resolve();
  });

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  const beforeRelease = [...order];

  install.release();

  await Promise.all([exec, locked]);

  expect(beforeRelease).toBeEmpty();
  expect(order).toStrictEqual(['exec started (1 sent)', 'lifecycle']);
});

test('it boots the imp again and checks again when a stop takes the lock before the exec', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const order: string[] = [];

  // the exec finds the imp running, then the stop takes the lock before the
  // exec's bundle step does
  const opening = ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] });

  const stopping = ctx.imps.lockImp('dev', async (locked) => {
    await ctx.imps.haltImp(locked, false);

    order.push('stopped');
  });

  const stream = await opening;

  stream.close();

  await stopping;

  expect(order).toStrictEqual(['stopped']);
  expect(ctx.bundleInstalls).toHaveLength(1);
  expect(agent.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
});

test('it refuses to start a session that requires the broker without a grant', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'main', require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the imp has no grant, so impd sets no broker variables',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it passes an attach that requires the broker to a session started with it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const started = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  started.close();

  const attached = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  attached.close();

  expect(attached.created).toBeFalse();
  expect(agent.readExecs()).toHaveLength(2);
});

test('it refuses an attach that requires the broker to a session started without it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const plain = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other' });

  ctx.stack.defer(() => {
    plain.close();
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other', require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'session other was started without the broker requirement',
    },
  });

  // refused before the agent saw it
  expect(agent.readExecs()).toHaveLength(1);
});

test('it leaves the viewer of a session its output after a refused attach', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const plain = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other' });

  ctx.stack.defer(() => {
    plain.close();
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'other', require: ['broker'] }),
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

  agent.writeOutput('other', Buffer.from('still'));

  const first = await plain.events().next();

  expect(first.value).toStrictEqual({ type: 'stdout', data: Buffer.from('still') });
});

test('it passes an attach that requires the broker after an impd restart', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const started = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  started.close();

  // a new impd adopts the running VM and its sessions
  const restarted = ctx.restartImpd();

  await restarted.imps.reconcileImps();

  const resumed = await restarted.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  resumed.close();

  expect(resumed.created).toBeFalse();
  expect(agent.readExecs()).toHaveLength(2);
});

test('it refuses an attach that requires the broker to a session a cold boot started without it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const started = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  started.close();

  const restarted = ctx.restartImpd();

  await restarted.imps.reconcileImps();

  // a cold boot: the guest's sessions are gone, and one started without
  // the requirement takes the name
  await restarted.imps.lockImp('dev', async (locked) => {
    const halted = await restarted.imps.haltImp(locked, false);

    await restarted.imps.bootImp(halted);
  });

  agent.clearRuns();

  const booted = readVmIdentity(paths);

  invariant(booted);
  writeVmIdentity(paths, { ...booted, agentVersion: '0.16.0' });

  const plain = await restarted.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'main' });

  plain.close();

  expect(
    restarted.imps.openExec('dev', {
      argv: ['sh'],
      tty: true,
      session: 'main',
      require: ['broker'],
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'session main was started without the broker requirement',
    },
  });
});

test('it keeps the record of an exited run while it is listed, so a resume of it passes', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const first = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
  });

  first.close();

  const run = agent.readRun('main');

  invariant(run);

  // main exits while detached; another required session starts after it
  agent.exitRun('main');

  const other = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'other',
    require: ['broker'],
  });

  other.close();

  const resumed = await ctx.imps.openExec('dev', {
    argv: ['sh'],
    tty: true,
    session: 'main',
    require: ['broker'],
    resumeFrom: { executionGeneration: run.generation, offset: 0 },
  });

  resumed.close();

  expect(resumed.created).toBeFalse();
  expect(agent.readExecs()).toHaveLength(3);
});

test('it refuses a resume of an exited run started without the requirement before the agent', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubSessionAgent(paths.vsockSocket, { stack: ctx.stack });

  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions; the stub VMM records an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const plain = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'job' });

  plain.close();

  const run = agent.readRun('job');

  invariant(run);

  agent.exitRun('job');

  expect(
    ctx.imps.openExec('dev', {
      argv: ['sh'],
      tty: true,
      session: 'job',
      require: ['broker'],
      resumeFrom: { executionGeneration: run.generation, offset: 0 },
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'session job was started without the broker requirement',
    },
  });

  // the agent never saw the resume, so it kept the exited run's output
  expect(agent.readExecs()).toHaveLength(1);
});
