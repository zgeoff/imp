import { expect, test } from 'bun:test';
import { buildTestCaller } from '../auth/test-callers';
import { buildGrantedBackend } from './exec-grant';
import type { ExecBackend } from './exec-session';

// a backend that records which imps it opened; the stream is never used
function buildBackend() {
  const opened: string[] = [];

  const backend: ExecBackend = {
    openExec: (name) => {
      opened.push(name);

      return Promise.reject(new Error('opened'));
    },
    openAttach: (name) => {
      opened.push(`attach ${name}`);

      return Promise.reject(new Error('opened'));
    },
    recordActivity: () => Promise.resolve(),
  };

  return { backend, opened };
}

test('a token grant starts any imp the token may exec in', async () => {
  const ctx = buildBackend();
  const granted = buildGrantedBackend(ctx.backend, { caller: buildTestCaller(), name: null });

  await granted.openExec('a', { argv: ['true'], tty: false }).catch(() => {});
  await granted.openExec('b', { argv: ['true'], tty: false }).catch(() => {});

  expect(ctx.opened).toEqual(['a', 'b']);
});

test('a ticket grant starts only its imp', async () => {
  const ctx = buildBackend();
  const caller = buildTestCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(ctx.backend, { caller, name: 'a' });

  await granted.openExec('a', { argv: ['true'], tty: false }).catch(() => {});
  await granted.openAttach('a', { session: 'main' }).catch(() => {});

  const rejection = await granted
    .openExec('b', { argv: ['true'], tty: false })
    .catch((error: unknown) => error);

  const attachRejection = await granted
    .openAttach('b', { session: 'main' })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(attachRejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual(['a', 'attach a']);
});

test('a read token starts nothing, and a patterned one only its imps', async () => {
  const ctx = buildBackend();

  const reader = buildGrantedBackend(ctx.backend, {
    caller: buildTestCaller({ scope: 'read' }),
    name: null,
  });

  const patterned = buildGrantedBackend(ctx.backend, {
    caller: buildTestCaller({ scope: 'exec', imps: ['dev-*'] }),
    name: null,
  });

  const readRejection = await reader
    .openExec('dev-a', { argv: ['true'], tty: false })
    .catch((error: unknown) => error);

  const otherRejection = await patterned
    .openAttach('prod', { session: 'main' })
    .catch((error: unknown) => error);

  await patterned.openExec('dev-a', { argv: ['true'], tty: false }).catch(() => {});

  expect(readRejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(otherRejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual(['dev-a']);
});

test('a socket with no grant starts nothing', async () => {
  const ctx = buildBackend();
  const granted = buildGrantedBackend(ctx.backend, undefined);

  const rejection = await granted
    .openExec('a', { argv: ['true'], tty: false })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual([]);
});

test('a ticket grant never starts a tool, even on its own imp', async () => {
  const ctx = buildBackend();
  const caller = buildTestCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(ctx.backend, { caller, name: 'a' });
  const request = { argv: ['/run/imp/sys/imp-agent', 'tar', 'create', '/etc'], tty: false };

  const rejection = await granted
    .openExec('a', { ...request, user: 'root' }, 'cp')
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual([]);
});

test('a token grant passes a tool and its feature through', async () => {
  const features: unknown[] = [];

  const backend: ExecBackend = {
    openExec: (_name, _request, feature) => {
      features.push(feature);

      return Promise.reject(new Error('opened'));
    },
    openAttach: () => Promise.reject(new Error('opened')),
    recordActivity: () => Promise.resolve(),
  };

  const granted = buildGrantedBackend(backend, { caller: buildTestCaller(), name: null });

  await granted.openExec('a', { argv: ['true'], tty: false, user: 'root' }, 'cp').catch(() => {});

  expect(features).toEqual(['cp']);
});

test('a read token cannot run a tool', async () => {
  const ctx = buildBackend();

  const reader = buildGrantedBackend(ctx.backend, {
    caller: buildTestCaller({ scope: 'read' }),
    name: null,
  });

  const rejection = await reader
    .openExec('a', { argv: ['tar'], tty: false, user: 'root' }, 'cp')
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual([]);
});

test('a pattern token runs a tool only on its imps', async () => {
  const ctx = buildBackend();

  const patterned = buildGrantedBackend(ctx.backend, {
    caller: buildTestCaller({ scope: 'manage', imps: ['dev-*'] }),
    name: null,
  });

  const tool = { argv: ['tar'], tty: false, user: 'root' };

  const rejection = await patterned.openExec('prod', tool, 'cp').catch((error: unknown) => error);

  await patterned.openExec('dev-a', tool, 'cp').catch(() => {});

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual(['dev-a']);
});

test('a tool needs manage: an exec token is refused, a manage token passes', async () => {
  const ctx = buildBackend();
  const tool = { argv: ['tar'], tty: false, user: 'root' };

  const execToken = buildGrantedBackend(ctx.backend, {
    caller: buildTestCaller({ scope: 'exec' }),
    name: null,
  });

  const manageToken = buildGrantedBackend(ctx.backend, {
    caller: buildTestCaller({ scope: 'manage' }),
    name: null,
  });

  const rejection = await execToken.openExec('a', tool, 'cp').catch((error: unknown) => error);

  await execToken.openExec('a', { argv: ['true'], tty: false }).catch(() => {});
  await manageToken.openExec('b', tool, 'cp').catch(() => {});

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual(['a', 'b']);
});
