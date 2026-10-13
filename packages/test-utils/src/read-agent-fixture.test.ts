import { expect, test } from 'bun:test';
import { readAgentFixture } from './read-agent-fixture';

test('it reads a fixture the agent wrote', () => {
  expect(readAgentFixture('guest/ok.json')).toStrictEqual({ ok: true });
});

test('it reads a fixture kept for the host', () => {
  expect(readAgentFixture('host/requests/ping.json')).toStrictEqual({ op: 'ping' });
});

test('it throws for a fixture that does not exist', () => {
  expect(() => readAgentFixture('guest/missing.json')).toThrow();
});
