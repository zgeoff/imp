import { expect, test } from 'bun:test';
import { ImageBuildRunSchema } from './image-build-run-schema';

test('#ImageBuildRunSchema accepts a build in its RUN step on a builder', () => {
  const payload = {
    name: 'web-app',
    source: 'upload',
    startedAt: new Date('2026-03-04T05:06:07.000Z'),
    phase: 'build',
    step: '[3/7] RUN make all',
    builder: 'imp-build-k3m9pqrs',
  } as const;

  expect(ImageBuildRunSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageBuildRunSchema accepts a build with no step and no builder yet', () => {
  const payload = {
    name: 'web-app',
    source: 'host',
    startedAt: new Date('2026-03-04T05:06:07.000Z'),
    phase: 'pack',
    step: null,
    builder: null,
  } as const;

  expect(ImageBuildRunSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageBuildRunSchema rejects an unknown source', () => {
  const result = ImageBuildRunSchema.safeParse({
    name: 'web-app',
    source: 'registry',
    startedAt: new Date('2026-03-04T05:06:07.000Z'),
    phase: 'build',
    step: null,
    builder: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['source'] });
});
