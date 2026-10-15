import { expect, test } from 'bun:test';
import { createBuildSteps } from './create-build-steps';

test('it takes a Dockerfile step that starts as the current one', () => {
  const steps: string[] = [];

  const tracker = createBuildSteps((step) => {
    steps.push(step);
  });

  tracker.start('a', '[1/3] FROM alpine');
  tracker.start('b', '[2/3] RUN make all');

  expect(steps).toStrictEqual(['[1/3] FROM alpine', '[2/3] RUN make all']);
});

test.each([
  ['[internal] load build definition from Dockerfile'],
  ['exporting to image'],
  ['resolve image config for docker-image://docker.io/docker/dockerfile:1'],
])('it passes over the vertex %s, which is no Dockerfile step', (name) => {
  const steps: string[] = [];

  const tracker = createBuildSteps((step) => {
    steps.push(step);
  });

  tracker.start('a', name);

  expect(steps).toStrictEqual([]);
});

test('it falls back to the last step still running when the current one ends', () => {
  const steps: string[] = [];

  const tracker = createBuildSteps((step) => {
    steps.push(step);
  });

  tracker.start('a', '[builder 2/4] RUN make all');
  tracker.start('b', '[stage-1 2/3] COPY etc /etc');
  tracker.end('b');

  expect(steps).toStrictEqual([
    '[builder 2/4] RUN make all',
    '[stage-1 2/3] COPY etc /etc',
    '[builder 2/4] RUN make all',
  ]);
});

test('it keeps the current step when another step ends, or when the last one ends', () => {
  const steps: string[] = [];

  const tracker = createBuildSteps((step) => {
    steps.push(step);
  });

  tracker.start('a', '[builder 2/4] RUN make all');
  tracker.start('b', '[stage-1 2/3] COPY etc /etc');
  tracker.end('a');
  tracker.end('b');
  tracker.end('c');

  expect(steps).toStrictEqual(['[builder 2/4] RUN make all', '[stage-1 2/3] COPY etc /etc']);
});
