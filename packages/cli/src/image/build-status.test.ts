import { expect, test } from 'bun:test';
import type { ImageBuildPhase, ImageBuildProgress } from '@imp/api';
import { createBuildStatus, formatBuildStatus } from './build-status';

function buildProgress(phase: ImageBuildPhase, elapsedMs: number): ImageBuildProgress {
  return { type: 'progress', phase, elapsedMs };
}

test('the line shows what impd does and for how long, in minutes and seconds', () => {
  expect(formatBuildStatus('build', 0, 'imp image build')).toBe('imp image build: building, 0m00s');

  expect(formatBuildStatus('pull', 605_400, 'imp image add')).toBe(
    'imp image add: pulling, 10m05s',
  );
});

test('a terminal gets the line redrawn from each phase’s start, and one newline at the end', () => {
  const written: string[] = [];

  const status = createBuildStatus(
    {
      isTTY: true,
      write: (text) => {
        written.push(text);
      },
    },
    'imp image add',
  );

  status.show(buildProgress('pull', 0));
  status.show(buildProgress('pull', 15_000));

  // the pull took 40 s of the stream
  status.show(buildProgress('unpack', 40_000));
  status.show(buildProgress('unpack', 55_000));
  status.finish();
  status.finish();

  expect(written).toEqual([
    '\rimp image add: pulling, 0m00s\u001B[K',
    '\rimp image add: pulling, 0m15s\u001B[K',
    '\rimp image add: unpacking, 0m00s\u001B[K',
    '\rimp image add: unpacking, 0m15s\u001B[K',
    '\n',
  ]);
});

test('off a terminal, or with nothing shown, it prints nothing', () => {
  const written: string[] = [];

  const output = {
    isTTY: false,
    write: (text: string) => {
      written.push(text);
    },
  };

  const offTerminal = createBuildStatus(output, 'imp image build');

  offTerminal.show(buildProgress('build', 15_000));
  offTerminal.finish();

  createBuildStatus({ ...output, isTTY: true }, 'imp image build').finish();

  expect(written).toEqual([]);
});
