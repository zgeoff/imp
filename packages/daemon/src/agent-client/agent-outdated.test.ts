import { expect, test } from 'bun:test';
import { hasSessions } from './agent-outdated';

test('sessions start with agent 0.2.0', () => {
  const versions = ['0.1.0', '0.1.9', '0.2.0', '0.10.1', '1.0.0', 'dev'];

  expect(versions.map((version) => hasSessions(version))).toEqual([
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
});
