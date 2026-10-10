import { expect, test } from 'bun:test';
import { buildStubAgentExecStream } from './build-stub-agent-exec-stream';
import { buildStubExecBackend } from './build-stub-exec-backend';

test('it opens an exec to the stream it was given and records the open', async () => {
  const fake = buildStubAgentExecStream();
  const stub = buildStubExecBackend({ exec: fake.stream });

  const stream = await stub.backend.openExec('dev', { argv: ['sh'], tty: true }, 'outer-exec');

  expect(stream).toBe(fake.stream);

  expect(stub.opens).toStrictEqual([
    { kind: 'exec', name: 'dev', request: { argv: ['sh'], tty: true }, feature: 'outer-exec' },
  ]);
});

test('it rejects an exec with the error it was given', () => {
  const stub = buildStubExecBackend({ exec: new Error('dev is stopped') });

  expect(stub.backend.openExec('dev', { argv: ['sh'], tty: false })).rejects.toThrowWithMessage(
    Error,
    'dev is stopped',
  );
});

test('it rejects an exec it was given nothing for as INVALID_STATE for a stopped imp', () => {
  const stub = buildStubExecBackend();

  expect(stub.backend.openExec('dev', { argv: ['sh'], tty: false })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    status: 409,
    message: 'cannot attach without a wake to an imp that is stopped (allowed: running)',
    data: { state: 'stopped', allowed: ['running'], coldBoots: [] },
  });
});

test('it opens an attach to the stream it was given and records the open', async () => {
  const fake = buildStubAgentExecStream({ session: 'main' });
  const stub = buildStubExecBackend({ attach: fake.stream });

  const stream = await stub.backend.openAttach('dev', { session: 'main' });

  expect(stream).toBe(fake.stream);
  expect(stub.opens).toStrictEqual([{ kind: 'attach', name: 'dev', request: { session: 'main' } }]);
});

test('it rejects an attach it was given nothing for as INVALID_STATE for a stopped imp', () => {
  const stub = buildStubExecBackend();

  expect(stub.backend.openAttach('dev', { session: 'main' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    status: 409,
    message: 'cannot attach without a wake to an imp that is stopped (allowed: running)',
    data: { state: 'stopped', allowed: ['running'], coldBoots: [] },
  });
});

test('it records each imp whose activity was recorded', async () => {
  const stub = buildStubExecBackend();

  await stub.backend.recordActivity('dev');

  expect(stub.activity).toStrictEqual(['dev']);
});
