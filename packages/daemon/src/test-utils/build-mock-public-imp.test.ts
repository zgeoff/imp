import { expect, test } from 'bun:test';
import { buildMockPublicImp } from './build-mock-public-imp';

test('it builds a default public imp', () => {
  expect(buildMockPublicImp()).toStrictEqual({
    id: expect.toSatisfy((id: string) => /^[\da-f\-]{36}$/v.test(id)),
    state: 'running',
    stored: {
      auth: 'basic',
      user: expect.toBeString(),
      hash: expect.toSatisfy((hash: string) => /^[\w\-]{43}$/v.test(hash)),
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  const imp = buildMockPublicImp({
    id: 'i1',
    state: 'sleeping',
    stored: { auth: 'token', user: null, hash: 'h' },
  });

  expect(imp).toStrictEqual({
    id: 'i1',
    state: 'sleeping',
    stored: { auth: 'token', user: null, hash: 'h' },
  });
});
