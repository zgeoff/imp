import { expect, test } from 'bun:test';
import { parseBalloonStats } from './balloon-stats';

test('it reads the total and the available memory in whole MiB', () => {
  const text = JSON.stringify({
    target_pages: 0,
    actual_pages: 0,
    target_mib: 0,
    actual_mib: 0,
    free_memory: 150_000_000,
    available_memory: 314_572_801,
    total_memory: 500_000_000,
  });

  expect(parseBalloonStats(text)).toStrictEqual({ totalMib: 476, availableMib: 300 });
});

test('it throws on an answer without the available memory', () => {
  expect(() => parseBalloonStats('{"total_memory":500000000}')).toThrowWithMessage(
    Error,
    'no available_memory in {"total_memory":500000000}',
  );
});

test('it throws on an answer without the total memory', () => {
  expect(() => parseBalloonStats('{"available_memory":314572801}')).toThrowWithMessage(
    Error,
    'no total_memory in {"available_memory":314572801}',
  );
});

test('it throws on an answer that is not an object', () => {
  expect(() => parseBalloonStats('null')).toThrowWithMessage(
    Error,
    'no balloon statistics in null',
  );
});
