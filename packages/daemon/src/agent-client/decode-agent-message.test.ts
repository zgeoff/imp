import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { ActivitySchema, ListeningSchema, PingSchema, StartedSchema } from './agent-protocol';
import { decodeAgentMessage } from './decode-agent-message';

test('it decodes a message from the agent’s JSON', () => {
  expect(
    decodeAgentMessage(ListeningSchema, { ok: true, port: 41_234, listener: 'l2' }),
  ).toStrictEqual(create(ListeningSchema, { ok: true, port: 41_234, listener: 'l2' }));
});

test('it drops a field a newer agent sends that the schema lacks', () => {
  expect(
    decodeAgentMessage(PingSchema, { ok: true, version: '0.99.0', newer_field: { a: 1 } }),
  ).toStrictEqual(create(PingSchema, { ok: true, version: '0.99.0' }));
});

test('it reads a 64-bit count an agent writes as a string', () => {
  expect(
    decodeAgentMessage(PingSchema, { ok: true, version: '0.18.0', uptime_ms: '5321' }).uptimeMs,
  ).toBe(5321);
});

test('it throws for a field of the wrong type', () => {
  expect(() => decodeAgentMessage(PingSchema, { ok: 'yes', version: '0.18.0' })).toThrow();
});

test.each([
  ['NaN', 'NaN'],
  ['Infinity', 'Infinity'],
  ['a negative number', -1],
  ['a fraction', 1.5],
  ['a number past 2^53', 2 ** 53],
])('it throws for an output offset that is %s', (_label, offset) => {
  expect(() =>
    decodeAgentMessage(StartedSchema, {
      pid: 7,
      session: 'web',
      output: {
        boot_id: '',
        execution_generation: '0123456789abcdef0123456789abcdef',
        buffer_start: 0,
        end: 10,
        offset,
        prelude: 0,
      },
    }),
  ).toThrowWithMessage(Error, /^imp\.agent\.v1\.Output\.offset: /);
});

test('it throws for a bad count in a list of messages', () => {
  expect(() =>
    decodeAgentMessage(ActivitySchema, {
      tcp_established: 0,
      exec_sessions: 0,
      load1: 0.5,
      sessions: [
        {
          name: 'web',
          pid: 7,
          argv: ['sh'],
          state: 'running',
          attached: false,
          cols: 80,
          rows: 24,
          started_unix_ms: 1_700_000_000_000,
          execution_generation: '',
          boot_id: '',
          end: -5,
        },
      ],
    }),
  ).toThrowWithMessage(Error, /^imp\.agent\.v1\.SessionInfo\.end: /);
});

test('it reads a load average that is a fraction', () => {
  expect(
    decodeAgentMessage(ActivitySchema, { tcp_established: 0, exec_sessions: 0, load1: 0.25 }).load1,
  ).toBe(0.25);
});

test('it throws for a load average that is not finite', () => {
  expect(() =>
    decodeAgentMessage(ActivitySchema, { tcp_established: 0, exec_sessions: 0, load1: 'NaN' }),
  ).toThrowWithMessage(Error, /^imp\.agent\.v1\.Activity\.load1: /);
});
