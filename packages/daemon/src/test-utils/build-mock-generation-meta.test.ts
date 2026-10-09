import { expect, test } from 'bun:test';
import { buildMockGenerationMeta } from './build-mock-generation-meta';

test('it builds a default generation meta', () => {
  expect(buildMockGenerationMeta()).toStrictEqual({
    version: 1,
    session: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    executionGeneration: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/.test(value)),
    bootId: expect.toSatisfy((value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
    ),
    startedAt: expect.toBeNumber(),
    origin: 0,
    segments: [],
    state: 'live',
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockGenerationMeta({
      session: 'main',
      executionGeneration: 'd'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      startedAt: 1,
      origin: 5,
      segments: [{ start: 5, length: 10 }],
      state: 'ended',
      endedAt: 2,
      end: 15,
      exitCode: null,
      stopped: 'disk_full',
    }),
  ).toStrictEqual({
    version: 1,
    session: 'main',
    executionGeneration: 'd'.repeat(32),
    bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    startedAt: 1,
    origin: 5,
    segments: [{ start: 5, length: 10 }],
    state: 'ended',
    endedAt: 2,
    end: 15,
    exitCode: null,
    stopped: 'disk_full',
  });
});
