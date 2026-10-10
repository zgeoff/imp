import { expect, test } from 'bun:test';
import { parseBalloonAvailableMib } from './balloon-stats';

test('it reads the available memory in whole MiB', () => {
  const text = JSON.stringify({
    target_pages: 0,
    actual_pages: 0,
    target_mib: 0,
    actual_mib: 0,
    free_memory: 150_000_000,
    available_memory: 314_572_801,
    total_memory: 500_000_000,
  });

  expect(parseBalloonAvailableMib(text)).toBe(300);
});

test('it throws on an answer without the available memory', () => {
  expect(() => parseBalloonAvailableMib('{"target_pages":0}')).toThrowWithMessage(
    Error,
    'no available_memory in {"target_pages":0}',
  );
});
