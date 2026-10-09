import { expect, test } from 'bun:test';
import { buildMockExtent } from './build-mock-extent';

test('it builds a default extent', () => {
  expect(buildMockExtent()).toStrictEqual({
    logical: expect.toSatisfy((value: number) => value >= 0 && value % 4096 === 0),
    physical: expect.toSatisfy((value: number) => value >= 0 && value % 4096 === 0),
    length: expect.toSatisfy((value: number) => value > 0 && value % 4096 === 0),
    flags: 0,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockExtent({ logical: 8192, physical: 1_048_576, length: 4096, flags: 0x20_00 }),
  ).toStrictEqual({ logical: 8192, physical: 1_048_576, length: 4096, flags: 0x20_00 });
});
