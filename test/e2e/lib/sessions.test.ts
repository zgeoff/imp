import { expect, test } from 'bun:test';
import { parseSessions } from './sessions';

test('#parseSessions reads each session the CLI lists, without the fields the suites ignore', () => {
  const stdout = JSON.stringify([
    {
      name: 'main',
      pid: 312,
      state: 'running',
      attached: false,
      cols: 80,
      rows: 24,
      startedAt: '2026-10-10T04:00:00.000Z',
    },
  ]);

  expect(parseSessions(stdout)).toStrictEqual([
    { name: 'main', pid: 312, state: 'running', attached: false, cols: 80, rows: 24 },
  ]);
});

test('#parseSessions rejects a row without a pid', () => {
  const stdout = JSON.stringify([
    { name: 'main', state: 'running', attached: false, cols: 80, rows: 24 },
  ]);

  expect(() => parseSessions(stdout)).toThrow();
});
