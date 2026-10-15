import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import { createImpTest } from '../imps/test-imps';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { startStubSessionAgent } from '../test-utils/start-stub-session-agent';

// A start that requires the broker and names a session passes only to a
// session whose run started with the requirement.

// impd over the stub VMM, and `stack`, whose releases (the agents a test
// starts) run before the harness's
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  // every create boots an image row; the default image is base
  await harness.createTestImage('base');

  return { ...harness, stack };
}

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

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  // main exits while detached; another required session starts after it
  agent.exitRun('main', { code: 0, signal: 0 });

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

  await waitFor(() => {
    expect(agent.readRun('job')?.isAttached).toBeFalse();
  });

  agent.exitRun('job', { code: 0, signal: 0 });

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
