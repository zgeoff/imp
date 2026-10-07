import { expect, test } from 'bun:test';
import { ImageOpEventSchema } from '../image-build-protocol';
import { buildMockImageBuildProgress } from './build-mock-image-build-progress';

test('it builds a default image build progress', () => {
  const progress = buildMockImageBuildProgress();
  const received: unknown = progress;

  expect(received).toStrictEqual({
    type: 'progress',
    phase: 'pull',
    elapsedMs: expect.toBeWithin(0, 3_600_001) as unknown,
  });

  expect(ImageOpEventSchema.parse(progress)).toStrictEqual(progress);
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockImageBuildProgress({ phase: 'unpack', elapsedMs: 40_000 })).toStrictEqual({
    type: 'progress',
    phase: 'unpack',
    elapsedMs: 40_000,
  });
});
