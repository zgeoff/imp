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

test('#formatBuildStatus ends with the step the build runs', () => {
  expect(formatBuildStatus('build', 65_000, 'imp image build', '[3/7] RUN make all')).toBe(
    'imp image build: building, 1m05s, [3/7] RUN make all',
  );
});

test('#createBuildStatus prints a plain line off a terminal at each phase and step, and every 30 s', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: false, write }, 'imp image build');

  status.show(buildMockImageBuildProgress({ phase: 'upload', elapsedMs: 0 }));
  status.show(buildMockImageBuildProgress({ phase: 'build', elapsedMs: 2000 }));

  status.show(
    buildMockImageBuildProgress({ phase: 'build', elapsedMs: 3000, step: '[2/3] RUN make all' }),
  );

  status.show(
    buildMockImageBuildProgress({ phase: 'build', elapsedMs: 18_000, step: '[2/3] RUN make all' }),
  );

  status.show(
    buildMockImageBuildProgress({ phase: 'build', elapsedMs: 33_000, step: '[2/3] RUN make all' }),
  );

  status.finish();

  expect(write.mock.calls).toStrictEqual([
    ['imp image build: uploading, 0m00s\n'],
    ['imp image build: building, 0m00s\n'],
    ['imp image build: building, 0m01s, [2/3] RUN make all\n'],
    ['imp image build: building, 0m31s, [2/3] RUN make all\n'],
  ]);
});

test('#createBuildStatus prints each line of the build output as it is off a terminal', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: false, write }, 'imp image build');

  status.printLog('#4 [2/3] RUN make all');
  status.printLog('#4 0.31 cc -o widget main.c');

  expect(write.mock.calls).toStrictEqual([
    ['#4 [2/3] RUN make all\n'],
    ['#4 0.31 cc -o widget main.c\n'],
  ]);
});

test('#createBuildStatus prints the build output above the terminal line and draws it again', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: true, write }, 'imp image build');

  status.show(
    buildMockImageBuildProgress({ phase: 'build', elapsedMs: 0, step: '[2/3] RUN make all' }),
  );

  status.printLog('#4 0.31 cc -o widget main.c');

  expect(write.mock.calls).toStrictEqual([
    ['\rimp image build: building, 0m00s, [2/3] RUN make all\u001B[K'],
    [
      '\r\u001B[K#4 0.31 cc -o widget main.c\nimp image build: building, 0m00s, [2/3] RUN make all\u001B[K',
    ],
  ]);
});

test('#createBuildStatus cuts a long step to fit the terminal line', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: true, write }, 'imp image build');

  status.show(
    buildMockImageBuildProgress({
      phase: 'build',
      elapsedMs: 0,
      step: `[2/3] RUN ${'x'.repeat(80)}`,
    }),
  );

  expect(write).toHaveBeenCalledExactlyOnceWith(
    `\rimp image build: building, 0m00s, [2/3] RUN ${'x'.repeat(49)}…\u001B[K`,
  );
});

test('#createBuildStatus prints nothing when quiet, on a terminal or off one', () => {
  const write = mock<(text: string) => void>();
  const onTerminal = createBuildStatus({ isTTY: true, write }, 'imp image build', true);
  const offTerminal = createBuildStatus({ isTTY: false, write }, 'imp image build', true);

  onTerminal.show(buildMockImageBuildProgress());
  onTerminal.printLog('#4 0.31 cc -o widget main.c');
  onTerminal.finish();
  offTerminal.show(buildMockImageBuildProgress());
  offTerminal.printLog('#4 0.31 cc -o widget main.c');

  expect(write).not.toHaveBeenCalled();
});

test('#createBuildStatus ends no line on a terminal when it showed nothing', () => {
  const write = mock<(text: string) => void>();
  const status = createBuildStatus({ isTTY: true, write }, 'imp image build');

  status.finish();

  expect(write).not.toHaveBeenCalled();
});
