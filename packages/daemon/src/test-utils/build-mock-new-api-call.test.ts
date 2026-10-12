import { expect, test } from 'bun:test';
import { buildMockNewApiCall } from './build-mock-new-api-call';

test('it builds a default new api call', () => {
  expect(buildMockNewApiCall()).toStrictEqual({
    at: expect.toBeValidDate(),
    procedure: expect.toStartWith('imps.'),
    actor: 'token',
    actorName: expect.toBeString(),
    impName: expect.toSatisfy((name: string) => /^[a-z0-9]{8}$/v.test(name)),
    outcome: 'ok',
    durationMs: expect.toBeWithin(0, 60_001),
    detail: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const call = buildMockNewApiCall({
    at: new Date(2),
    procedure: 'images.add',
    actor: 'dashboard',
    actorName: 'laptop',
    impName: null,
    outcome: 'CONFLICT',
    durationMs: 12,
    detail: 'docker.io/library/busybox',
  });

  expect(call).toStrictEqual({
    at: new Date(2),
    procedure: 'images.add',
    actor: 'dashboard',
    actorName: 'laptop',
    impName: null,
    outcome: 'CONFLICT',
    durationMs: 12,
    detail: 'docker.io/library/busybox',
  });
});
