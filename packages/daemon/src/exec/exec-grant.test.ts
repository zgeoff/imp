import { expect, test } from 'bun:test';
import { ANY_IMP_GRANT, buildGrantedBackend } from './exec-grant';
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

test('the bearer grant starts any imp', async () => {
  const ctx = buildBackend();
  const granted = buildGrantedBackend(ctx.backend, ANY_IMP_GRANT);

  await granted.openExec('a', { argv: ['true'], tty: false }).catch(() => {});
  await granted.openExec('b', { argv: ['true'], tty: false }).catch(() => {});

  expect(ctx.opened).toEqual(['a', 'b']);
});

test('a ticket grant starts only its imp', async () => {
  const ctx = buildBackend();
  const granted = buildGrantedBackend(ctx.backend, { kind: 'imp', name: 'a' });

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

test('a socket with no grant starts nothing', async () => {
  const ctx = buildBackend();
  const granted = buildGrantedBackend(ctx.backend, undefined);

  const rejection = await granted
    .openExec('a', { argv: ['true'], tty: false })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'FORBIDDEN' });
  expect(ctx.opened).toEqual([]);
});
