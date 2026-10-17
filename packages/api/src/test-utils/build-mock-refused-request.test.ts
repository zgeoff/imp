import { expect, test } from 'bun:test';
import { RefusedRequestSchema } from '../schemas/secret-schema';
import { buildMockRefusedRequest } from './build-mock-refused-request';

test('it builds a default refused request', () => {
  const refused = buildMockRefusedRequest();
  const parsed: unknown = RefusedRequestSchema.safeParse(refused).data;
  const received: unknown = refused;

  expect(received).toStrictEqual({
    at: expect.toBeValidDate() as unknown,
    imp: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u) as unknown,
    method: 'CONNECT',
    host: expect.toBeString() as unknown,
    path: null,
    status: 403,
    durationMs: expect.toBeWithin(0, 60_001) as unknown,
    reason: 'egress-policy',
  });

  expect(parsed).toStrictEqual(refused);
});

test('it applies overrides on top of the defaults', () => {
  const refused: unknown = buildMockRefusedRequest({
    method: 'GET',
    host: 'api.github.com',
    path: '/stream',
    status: 426,
    reason: 'websocket',
  });

  expect(refused).toStrictEqual({
    at: expect.toBeValidDate() as unknown,
    imp: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/u) as unknown,
    method: 'GET',
    host: 'api.github.com',
    path: '/stream',
    status: 426,
    durationMs: expect.toBeWithin(0, 60_001) as unknown,
    reason: 'websocket',
  });
});
