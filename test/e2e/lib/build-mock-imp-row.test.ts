import { expect, test } from 'bun:test';
import { buildMockImpRow } from './build-mock-imp-row';

test('it builds a default imp row', () => {
  expect(buildMockImpRow()).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toStartWith('e2e-'),
    image: expect.toStartWith('e2e-'),
    state: 'running',
    vcpus: expect.toBeNumber(),
    memoryMib: expect.toBeNumber(),
    slot: expect.toBeNumber(),
    ip: expect.toBeString(),
    port: expect.toBeNumber(),
    url: expect.toBeString(),
    lastActiveAt: expect.toSatisfy((at: string) => new Date(at).toISOString() === at),
  });
});

test('it applies overrides on top of the defaults', () => {
  const row = buildMockImpRow({ name: 'e2e-rs-mem', state: 'sleeping', ramMib: 61 });

  expect(row).toMatchObject({ name: 'e2e-rs-mem', state: 'sleeping', ramMib: 61 });
});
