import { expect, test } from 'bun:test';
import { buildMockSessionOutput } from './build-mock-session-output';

test('it builds a default session output', () => {
  const output = buildMockSessionOutput();

  expect(output).toStrictEqual({
    continuity: 'offsets',
    bootId: expect.toBeString(),
    executionGeneration: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/.test(value)),
    bufferStart: 0,
    end: output.offset,
    offset: expect.toBeNumber(),
    prelude: 0,
    coldBoots: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  const output = buildMockSessionOutput({
    bootId: 'boot-1',
    executionGeneration: 'a'.repeat(32),
    bufferStart: 10,
    end: 100,
    offset: 90,
    prelude: 3,
    coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-10-03T00:00:00.000Z' }],
    log: { enabled: true },
  });

  expect(output).toStrictEqual({
    continuity: 'offsets',
    bootId: 'boot-1',
    executionGeneration: 'a'.repeat(32),
    bufferStart: 10,
    end: 100,
    offset: 90,
    prelude: 3,
    coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-10-03T00:00:00.000Z' }],
    log: { enabled: true },
  });
});
