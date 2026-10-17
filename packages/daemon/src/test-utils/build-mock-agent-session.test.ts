import { expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { ExitSchema } from '../agent-client/agent-protocol';
import { buildMockAgentSession } from './build-mock-agent-session';

test('it builds a default agent session', () => {
  expect(buildMockAgentSession()).toStrictEqual({
    $typeName: 'imp.agent.v1.SessionInfo',
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    pid: expect.toBeNumber(),
    argv: [expect.toBeString()],
    state: 'running',
    attached: false,
    cols: expect.toBeNumber(),
    rows: expect.toBeNumber(),
    startedUnixMs: expect.toBeNumber(),
    executionGeneration: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/u.test(value)),
    bootId: expect.toSatisfy((value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value),
    ),
    end: 0,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockAgentSession({
      name: 'main',
      pid: 7,
      argv: ['sh'],
      state: 'exited',
      attached: true,
      cols: 80,
      rows: 24,
      startedUnixMs: 1,
      exit: { code: 0, signal: 0 },
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      end: 12,
      log: true,
    }),
  ).toStrictEqual({
    $typeName: 'imp.agent.v1.SessionInfo',
    name: 'main',
    pid: 7,
    argv: ['sh'],
    state: 'exited',
    attached: true,
    cols: 80,
    rows: 24,
    startedUnixMs: 1,
    exit: create(ExitSchema, { code: 0, signal: 0 }),
    executionGeneration: 'a'.repeat(32),
    bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    end: 12,
    log: true,
  });
});
