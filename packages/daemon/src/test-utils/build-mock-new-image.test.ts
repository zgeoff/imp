import { expect, test } from 'bun:test';
import { buildMockNewImage } from './build-mock-new-image';

test('it builds a default new image', () => {
  expect(buildMockNewImage()).toStrictEqual({
    name: expect.toSatisfy((name: string) => /^[a-z0-9]{12}$/v.test(name)),
    ref: expect.toSatisfy((ref: string) => /^imp\/.+:latest$/v.test(ref)),
    digest: expect.toSatisfy((digest: string) => /^sha256:[0-9a-f]{64}$/v.test(digest)),
    sizeBytes: expect.toBeWithin(1, 1024 ** 3 + 1),
  });
});

test('it applies overrides on top of the defaults', () => {
  const image = buildMockNewImage({
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
    source: 'imp',
    sourceImp: 'dev',
  });

  expect(image).toStrictEqual({
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
    source: 'imp',
    sourceImp: 'dev',
  });
});
