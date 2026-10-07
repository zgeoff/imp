import { expect, mock, test } from 'bun:test';
import { createCopyProgress, formatProgress } from './copy-progress';

test('#formatProgress shows the percent of a known total', () => {
  expect(formatProgress(1_048_576 * 30, 1_048_576 * 120)).toBe('imp cp: 25% 30.0 MiB of 120.0 MiB');
});

test('#formatProgress shows the bytes so far when the total is unknown', () => {
  expect(formatProgress(1_048_576 / 2, null)).toBe('imp cp: 0.5 MiB');
});

test('#formatProgress shows the bytes so far when the total is zero', () => {
  expect(formatProgress(1_048_576, 0)).toBe('imp cp: 1.0 MiB');
});

test('#formatProgress starts the line with the label it is given', () => {
  expect(formatProgress(1_048_576, null, 'imp move')).toBe('imp move: 1.0 MiB');
});

test('#createCopyProgress redraws a terminal line at most every 250 ms and ends it with a newline', () => {
  const write = mock<(text: string) => void>();
  const clock = { now: 1000 };
  const progress = createCopyProgress({ isTTY: true, write }, () => clock.now);

  progress.setTotal(1_048_576 * 10);
  progress.add(1_048_576);
  progress.add(1_048_576);

  clock.now += 300;

  progress.add(1_048_576);
  progress.finish();

  expect(write.mock.calls).toStrictEqual([
    ['\rimp cp: 10% 1.0 MiB of 10.0 MiB\u001B[K'],
    ['\rimp cp: 30% 3.0 MiB of 10.0 MiB\u001B[K'],
    ['\rimp cp: 30% 3.0 MiB of 10.0 MiB\u001B[K'],
    ['\n'],
  ]);
});

test('#createCopyProgress ends the line only once when it finishes twice', () => {
  const write = mock<(text: string) => void>();
  const progress = createCopyProgress({ isTTY: true, write }, () => 1000);

  progress.add(10);
  progress.finish();
  write.mockClear();
  progress.finish();

  expect(write).not.toHaveBeenCalled();
});

test('#createCopyProgress prints nothing off a terminal', () => {
  const write = mock<(text: string) => void>();
  const progress = createCopyProgress({ isTTY: false, write }, () => 1000);

  progress.add(10);
  progress.finish();

  expect(write).not.toHaveBeenCalled();
});
