import { expect, test } from 'bun:test';
import { RequestSchema } from './agent-protocol';
import { encodeAgentMessage } from './encode-agent-message';

test('it writes a request under the schema’s field names', () => {
  expect(
    encodeAgentMessage(RequestSchema, {
      op: 'exec',
      argv: ['make'],
      tty: false,
      killGraceMs: 5000,
      resumeFrom: { executionGeneration: '0123456789abcdef0123456789abcdef', offset: 4096 },
    }),
  ).toStrictEqual({
    op: 'exec',
    argv: ['make'],
    tty: false,
    kill_grace_ms: 5000,
    resume_from: { execution_generation: '0123456789abcdef0123456789abcdef', offset: 4096 },
  });
});

// an older agent decodes int64 with encoding/json, which refuses a string
test('it writes a count past 32 bits as a JSON number', () => {
  expect(
    encodeAgentMessage(RequestSchema, { op: 'grow', diskBytes: 34_359_738_368 }),
  ).toStrictEqual({
    op: 'grow',
    disk_bytes: 34_359_738_368,
  });
});

test('it leaves out a field at its zero unless the request sets it', () => {
  expect(
    encodeAgentMessage(RequestSchema, {
      op: 'session.tap',
      session: 'build',
      resumeFrom: { executionGeneration: '0123456789abcdef0123456789abcdef', offset: 0 },
    }),
  ).toStrictEqual({
    op: 'session.tap',
    session: 'build',
    resume_from: { execution_generation: '0123456789abcdef0123456789abcdef' },
  });
});
