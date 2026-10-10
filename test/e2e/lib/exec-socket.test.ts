import { expect, test } from 'bun:test';
import { requireSessionError } from './exec-socket';

test('#requireSessionError returns the code and data of a refused open', () => {
  const refusal = requireSessionError({
    first: {
      type: 'error',
      code: 'INVALID_STATE',
      message: 'imp e2e-x-a is stopped',
      data: {
        state: 'stopped',
        coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-10-10T04:00:00.000Z' }],
      },
    },
    readBytes: () => Promise.resolve(new Uint8Array()),
    received: () => 0,
    close: () => {},
  });

  expect(refusal).toStrictEqual({
    code: 'INVALID_STATE',
    data: {
      state: 'stopped',
      coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-10-10T04:00:00.000Z' }],
    },
  });
});

test('#requireSessionError rejects an open that started', () => {
  expect(() =>
    requireSessionError({
      first: { type: 'exit', offset: 0 },
      readBytes: () => Promise.resolve(new Uint8Array()),
      received: () => 0,
      close: () => {},
    }),
  ).toThrowWithMessage(Error, 'expected an error, got {"type":"exit","offset":0}');
});

test('#requireSessionError rejects error data without the cold boots', () => {
  expect(() =>
    requireSessionError({
      first: { type: 'error', code: 'NO_SESSION', message: 'no session out', data: {} },
      readBytes: () => Promise.resolve(new Uint8Array()),
      received: () => 0,
      close: () => {},
    }),
  ).toThrow(/coldBoots/v);
});
