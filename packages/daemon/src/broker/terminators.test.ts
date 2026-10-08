import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateBrokerCa } from './broker-ca';
import type { LeafCertificate } from './broker-ca';
import { createTerminators } from './terminators';
import type { TerminatorKey } from './terminators';

// The terminators a test makes stop before the directory their sockets sit
// in goes: each test defers its stop into `ctx.stack`.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-term-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  // the CA every leaf comes from
  const ca = await loadOrCreateBrokerCa(join(dir, 'ca'));

  return { dir, ca, stack };
}

test('it serves the handler for its pair over TLS on the socket it opens', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: (key) => () => Promise.resolve(new Response(`${key.impId} ${key.host}`)),
  });

  ctx.stack.defer(() => terminators.stop());

  const socket = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });

  const response = await fetch('https://api.github.com/x', {
    unix: socket,
    tls: { ca: [ctx.ca.certPem] },
  });

  const text = await response.text();

  expect(text).toBe('imp-1 api.github.com');
});

test('it removes the sockets an earlier run left', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'run'));
  writeFileSync(join(ctx.dir, 'run', '1.sock'), '');

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  expect(readdirSync(join(ctx.dir, 'run'))).toStrictEqual([]);
});

test('it makes the socket directory owner-only', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  expect(statSync(join(ctx.dir, 'run')).mode & 0o777).toBe(0o700);
});

test('it starts one server for a pair opened twice at once', async () => {
  const ctx = await setupTest();

  const issueLeaf = mock(ctx.ca.issueLeaf);

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  const sockets = await Promise.all([
    terminators.open({ impId: 'imp-1', host: 'api.github.com' }),
    terminators.open({ impId: 'imp-1', host: 'api.github.com' }),
  ]);

  expect(sockets[1]).toBe(sockets[0]);
  expect(issueLeaf).toHaveBeenCalledOnce();
});

test('it starts a server for each pair', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  const sockets = await Promise.all([
    terminators.open({ impId: 'imp-1', host: 'api.github.com' }),
    terminators.open({ impId: 'imp-2', host: 'api.github.com' }),
  ]);

  expect(sockets[0]).not.toBe(sockets[1]);
});

test('it starts a server again for a pair whose start failed', async () => {
  const ctx = await setupTest();

  const issueLeaf = mock(ctx.ca.issueLeaf);

  issueLeaf.mockImplementationOnce(() => Promise.reject(new Error('no key')));

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  await Promise.allSettled([terminators.open({ impId: 'imp-1', host: 'api.github.com' })]);

  const socket = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });

  expect(existsSync(socket)).toBeTrue();
  expect(issueLeaf).toHaveBeenCalledTimes(2);
});

test('it rejects an open whose server cannot start', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: () => Promise.reject(new Error('no key')),
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  expect(terminators.open({ impId: 'imp-1', host: 'api.github.com' })).rejects.toThrowWithMessage(
    Error,
    'no key',
  );
});

test('it stops the server of a pair the prune does not keep', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  const kept = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });
  const dropped = await terminators.open({ impId: 'imp-2', host: 'api.github.com' });

  await terminators.prune((key: TerminatorKey) => key.impId === 'imp-1');

  expect(existsSync(kept)).toBeTrue();
  expect(existsSync(dropped)).toBeFalse();
});

test('it keeps the server of a pair the prune keeps', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  const before = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });

  await terminators.prune(() => true);

  const after = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });

  expect(after).toBe(before);
});

test('it issues a new leaf for a kept pair whose leaf is due', async () => {
  const ctx = await setupTest();

  const issued: LeafCertificate[] = [];

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: async (host) => {
      const leaf = await ctx.ca.issueLeaf(host);

      issued.push(leaf);

      return leaf;
    },
    isLeafDue: (leaf) => leaf === issued[0],
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  const before = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });

  await terminators.prune(() => true);

  const after = await terminators.open({ impId: 'imp-1', host: 'api.github.com' });

  expect(after).not.toBe(before);
  expect(issued).toHaveLength(2);
  expect(existsSync(before)).toBeFalse();
});

test('it removes the socket directory when it stops', async () => {
  const ctx = await setupTest();

  const terminators = createTerminators({
    socketDir: join(ctx.dir, 'run'),
    issueLeaf: ctx.ca.issueLeaf,
    isLeafDue: () => false,
    createHandler: () => () => Promise.resolve(new Response('ok')),
  });

  ctx.stack.defer(() => terminators.stop());

  await terminators.open({ impId: 'imp-1', host: 'api.github.com' });
  await terminators.stop();

  expect(existsSync(join(ctx.dir, 'run'))).toBeFalse();
});
