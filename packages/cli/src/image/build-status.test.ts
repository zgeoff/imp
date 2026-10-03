import { expect, test } from 'bun:test';
import { createBuildStatus, formatBuildStatus } from './build-status';

test('the line shows how long impd has built, in minutes and seconds', () => {
  expect(formatBuildStatus(0, 'imp image build')).toBe('imp image build: building, 0m00s');
  expect(formatBuildStatus(605_400, 'imp image build')).toBe('imp image build: building, 10m05s');
});

test('a terminal gets the line redrawn, and one newline at the end', () => {
  const written: string[] = [];

  const status = createBuildStatus(
    {
      isTTY: true,
      write: (text) => {
        written.push(text);
      },
    },
    'imp image build',
  );

  status.show(15_000);
  status.show(30_000);
  status.finish();
  status.finish();

  expect(written).toEqual([
    '\rimp image build: building, 0m15s\u001B[K',
    '\rimp image build: building, 0m30s\u001B[K',
    '\n',
  ]);
});

test('off a terminal, or with no build phase, it prints nothing', () => {
  const written: string[] = [];

  const output = {
    isTTY: false,
    write: (text: string) => {
      written.push(text);
    },
  };

  const offTerminal = createBuildStatus(output, 'imp image build');

  offTerminal.show(15_000);
  offTerminal.finish();

  createBuildStatus({ ...output, isTTY: true }, 'imp image build').finish();

  expect(written).toEqual([]);
});
