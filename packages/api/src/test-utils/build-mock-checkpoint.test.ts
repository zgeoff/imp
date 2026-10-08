import { expect, test } from 'bun:test';
import { CheckpointSchema } from '../checkpoint-schema';
import { buildMockCheckpoint } from './build-mock-checkpoint';

test('it builds a default checkpoint', () => {
  const checkpoint = buildMockCheckpoint();
  const parsed: unknown = CheckpointSchema.safeParse(checkpoint).data;
  const received: unknown = checkpoint;

  expect(received).toStrictEqual({
    id: expect.stringMatching(/^cp-[a-z0-9]{6}$/) as unknown,
    label: expect.any(String) as unknown,
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    diskMib: expect.any(Number) as unknown,
  });

  expect(parsed).toStrictEqual(checkpoint);
});

test('it applies overrides on top of the defaults', () => {
  const checkpoint: unknown = buildMockCheckpoint({ id: 'cp-a2b3c4', diskMib: 32_768 });

  expect(checkpoint).toStrictEqual({
    id: 'cp-a2b3c4',
    label: expect.any(String) as unknown,
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    diskMib: 32_768,
  });
});
