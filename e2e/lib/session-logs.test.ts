import { expect, test } from 'bun:test';
import { parseSessionLogs } from './session-logs';

test('it reads a live log and an ended one', () => {
  const stdout = JSON.stringify([
    {
      session: 'out',
      executionGeneration: 'gen-1',
      state: 'live',
      logStart: 0,
      logEnd: 1_048_576,
      bytes: 1_048_576,
      complete: false,
    },
    {
      session: 'done',
      executionGeneration: 'gen-2',
      state: 'ended',
      logStart: 0,
      logEnd: 10,
      bytes: 10,
      end: 10,
      exitCode: 7,
      complete: true,
    },
  ]);

  expect(parseSessionLogs(stdout)).toStrictEqual([
    {
      session: 'out',
      executionGeneration: 'gen-1',
      state: 'live',
      logStart: 0,
      logEnd: 1_048_576,
      bytes: 1_048_576,
      complete: false,
    },
    {
      session: 'done',
      executionGeneration: 'gen-2',
      state: 'ended',
      logStart: 0,
      logEnd: 10,
      bytes: 10,
      end: 10,
      exitCode: 7,
      complete: true,
    },
  ]);
});

test('it rejects a state it does not know', () => {
  const stdout = JSON.stringify([
    {
      session: 'out',
      executionGeneration: 'gen-1',
      state: 'paused',
      logStart: 0,
      logEnd: 0,
      bytes: 0,
      complete: false,
    },
  ]);

  expect(() => parseSessionLogs(stdout)).toThrowErrorMatchingInlineSnapshot(`
    "[
      {
        "code": "invalid_value",
        "values": [
          "live",
          "ended"
        ],
        "path": [
          0,
          "state"
        ],
        "message": "Invalid option: expected one of \\"live\\"|\\"ended\\""
      }
    ]"
  `);
});
