import { expect, test } from 'bun:test';
import { buildMockSavedTarget } from './build-mock-saved-target';

test('it builds a default saved target', () => {
  const target = buildMockSavedTarget();
  const received: unknown = target;

  expect(received).toStrictEqual({
    host: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    config: {
      url: expect.stringMatching(/^https?:\/\/[^/]+$/) as unknown,
      token: expect.stringMatching(/^[a-zA-Z0-9]{24}$/) as unknown,
      host: target.host,
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  const target: unknown = buildMockSavedTarget({
    host: 'old',
    config: { url: 'http://old:7070', token: null },
  });

  expect(target).toStrictEqual({
    host: 'old',
    config: { url: 'http://old:7070', token: null, host: 'old' },
  });
});
