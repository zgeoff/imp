import { expect, test } from 'bun:test';
import { createCopyProgress, formatProgress } from './copy-progress';

test('the line shows the percent of a known total, else the bytes so far', () => {
  expect(formatProgress(1_048_576 * 30, 1_048_576 * 120)).toBe('imp cp: 25% 30.0 MiB of 120.0 MiB');
  expect(formatProgress(1_048_576 / 2, null)).toBe('imp cp: 0.5 MiB');
});

test('a terminal gets a redrawn line at most every 250 ms, and a newline at the end', () => {
  const written: string[] = [];
  const clock = { now: 1000 };

  const progress = createCopyProgress(
    {
      isTTY: true,
      write: (text) => {
        written.push(text);
      },
    },
    () => clock.now,
  );

  progress.setTotal(100);
  progress.add(10);
  progress.add(10);

  clock.now += 300;

  progress.add(10);
  progress.finish();

  expect(written).toHaveLength(4);
  expect(written.at(-2)).toContain('30%');
  expect(written.at(-1)).toBe('\n');
});

test('off a terminal it prints nothing', () => {
  const written: string[] = [];

  const progress = createCopyProgress({
    isTTY: false,
    write: (text) => {
      written.push(text);
    },
  });

  progress.add(10);
  progress.finish();

  expect(written).toEqual([]);
});
