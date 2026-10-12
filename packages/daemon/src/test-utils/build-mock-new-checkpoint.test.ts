import { expect, test } from 'bun:test';
import { buildMockNewCheckpoint } from './build-mock-new-checkpoint';

test('it builds a default new checkpoint', () => {
  // no diskBytes or createdAt, so createCheckpoint's own defaults apply
  expect(buildMockNewCheckpoint()).toStrictEqual({
    id: expect.toSatisfy((id: string) => /^[a-z0-9]{12}$/v.test(id)),
    impId: expect.toBeString(),
    label: expect.toBeString(),
    sizeBytes: expect.toBeWithin(1, 1024 ** 3 + 1),
  });
});

test('it applies overrides on top of the defaults', () => {
  const checkpoint = buildMockNewCheckpoint({
    id: 'cp-one',
    impId: 'imp-1',
    label: null,
    sizeBytes: null,
    diskBytes: 4096,
    createdAt: new Date(1000),
  });

  expect(checkpoint).toStrictEqual({
    id: 'cp-one',
    impId: 'imp-1',
    label: null,
    sizeBytes: null,
    diskBytes: 4096,
    createdAt: new Date(1000),
  });
});
