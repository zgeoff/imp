import { expect, test } from 'bun:test';
import { buildMockAgentSession } from './build-mock-agent-session';

test('it builds a default agent session', () => {
  expect(buildMockAgentSession()).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    pid: expect.toBeNumber(),
    argv: [expect.toBeString()],
    state: 'running',
    attached: false,
    cols: expect.toBeNumber(),
    rows: expect.toBeNumber(),
    started_unix_ms: expect.toBeNumber(),
    execution_generation: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/.test(value)),
    boot_id: expect.toSatisfy((value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
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
      started_unix_ms: 1,
      exit: { code: 0, signal: 0 },
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      end: 12,
      log: true,
    }),
  ).toStrictEqual({
    name: 'main',
    pid: 7,
    argv: ['sh'],
    state: 'exited',
    attached: true,
    cols: 80,
    rows: 24,
    started_unix_ms: 1,
    exit: { code: 0, signal: 0 },
    execution_generation: 'a'.repeat(32),
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    end: 12,
    log: true,
  });
});
