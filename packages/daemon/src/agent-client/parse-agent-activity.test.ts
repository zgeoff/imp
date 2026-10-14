import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { ActivitySchema } from './agent-protocol';
import { parseAgentActivity } from './parse-agent-activity';

test('it parses the counts and the sessions the agent lists', () => {
  expect(
    parseAgentActivity({
      tcp_established: 2,
      exec_sessions: 1,
      load1: 0.25,
      sessions: [
        {
          name: 'build',
          pid: 812,
          argv: ['make'],
          state: 'running',
          attached: false,
          cols: 120,
          rows: 40,
          started_unix_ms: 1_760_000_000_000,
          execution_generation: '0123456789abcdef0123456789abcdef',
          boot_id: '6f1c2a9e-3b7d-4e58-9a10-2c4b8d7e5f31',
          end: 9000,
        },
      ],
    }),
  ).toStrictEqual(
    create(ActivitySchema, {
      tcpEstablished: 2,
      execSessions: 1,
      load1: 0.25,
      sessions: [
        {
          name: 'build',
          pid: 812,
          argv: ['make'],
          state: 'running',
          cols: 120,
          rows: 40,
          startedUnixMs: 1_760_000_000_000,
          executionGeneration: '0123456789abcdef0123456789abcdef',
          bootId: '6f1c2a9e-3b7d-4e58-9a10-2c4b8d7e5f31',
          end: 9000,
        },
      ],
    }),
  );
});

test('it lists no sessions for an agent from before sessions', () => {
  expect(
    parseAgentActivity({ tcp_established: 0, exec_sessions: 0, load1: 0 }).sessions,
  ).toStrictEqual([]);
});

test.each([
  ['does not decode', { name: 'bad', pid: 'one', state: 'running' }],
  [
    'names a generation the agent never makes',
    { name: 'bad', state: 'running', execution_generation: 'x' },
  ],
  ['is in a state impd does not know', { name: 'bad', state: 'paused' }],
])('it drops a session that %s and keeps the rest', (_label, bad) => {
  const activity = parseAgentActivity({
    tcp_established: 1,
    exec_sessions: 0,
    load1: 0,
    sessions: [bad, { name: 'good', state: 'running' }],
  });

  expect(activity.sessions.map((session) => session.name)).toStrictEqual(['good']);
});

test('it throws when the counts do not decode', () => {
  expect(() => parseAgentActivity({ tcp_established: 'many' })).toThrow();
});
