import { expect, mock, test } from 'bun:test';
import { buildMockImageBuildProgress } from '@imp/api/test-utils/build-mock-image-build-progress';
import { createBuildStatus, formatBuildStatus } from './build-status';

test('#formatBuildStatus shows what impd does for no time yet', () => {
  expect(formatBuildStatus('build', 0, 'imp image build')).toBe('imp image build: building, 0m00s');
});

test('#formatBuildStatus shows how long impd has done it in minutes and seconds', () => {
  expect(formatBuildStatus('pull', 605_400, 'imp image add')).toBe(
    'imp image add: pulling, 10m05s',
  );
});

test('#createBuildStatus redraws a terminal line timed from each phase’s start and ends it once', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: true, write }, 'imp image add');

  status.show(buildMockImageBuildProgress({ phase: 'pull', elapsedMs: 0 }));
  status.show(buildMockImageBuildProgress({ phase: 'pull', elapsedMs: 15_000 }));
  status.show(buildMockImageBuildProgress({ phase: 'unpack', elapsedMs: 40_000 }));
  status.show(buildMockImageBuildProgress({ phase: 'unpack', elapsedMs: 55_000 }));
  status.finish();
  status.finish();

  expect(write.mock.calls).toStrictEqual([
    ['\rimp image add: pulling, 0m00s\u001B[K'],
    ['\rimp image add: pulling, 0m15s\u001B[K'],
    ['\rimp image add: unpacking, 0m00s\u001B[K'],
    ['\rimp image add: unpacking, 0m15s\u001B[K'],
    ['\n'],
  ]);
});

test('#createBuildStatus prints nothing off a terminal', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: false, write }, 'imp image build');

  status.show(buildMockImageBuildProgress());
  status.finish();

  expect(write).not.toHaveBeenCalled();
});

test('#createBuildStatus ends no line on a terminal when it showed nothing', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: true, write }, 'imp image build');

  status.finish();

  expect(write).not.toHaveBeenCalled();
});
