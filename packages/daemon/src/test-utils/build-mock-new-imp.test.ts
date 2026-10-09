import { expect, test } from 'bun:test';
import { buildMockNewImp } from './build-mock-new-imp';

test('it builds a default new imp', () => {
  expect(buildMockNewImp()).toStrictEqual({
    name: expect.toSatisfy((name: string) => /^[a-z]{8}$/u.test(name)),
    imageId: expect.toBeString(),
    vcpus: expect.toBeWithin(1, 5),
    memoryMib: expect.toBeOneOf([256, 512, 1024, 2048]),
    slot: 0,
    ip: '10.66.0.2',
  });
});

test('it applies overrides on top of the defaults', () => {
  const imp = buildMockNewImp({
    name: 'stuck',
    imageId: 'image-1',
    vcpus: 2,
    memoryMib: 768,
    slot: 20,
    ip: '10.66.0.82',
    kind: 'builder',
  });

  expect(imp).toStrictEqual({
    name: 'stuck',
    imageId: 'image-1',
    vcpus: 2,
    memoryMib: 768,
    slot: 20,
    ip: '10.66.0.82',
    kind: 'builder',
  });
});
