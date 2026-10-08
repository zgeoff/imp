import { expect, test } from 'bun:test';
import { ApiCallSchema } from '../api-call-schema';
import { buildMockApiCall } from './build-mock-api-call';

test('it builds a default api call', () => {
  const call = buildMockApiCall();
  const parsed: unknown = ApiCallSchema.safeParse(call).data;
  const received: unknown = call;

  expect(received).toStrictEqual({
    at: expect.toBeValidDate() as unknown,
    procedure: expect.toBeOneOf(['imps.stop', 'imps.start', 'imps.create']) as unknown,
    actor: 'token',
    actorName: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    imp: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    outcome: 'ok',
    durationMs: expect.any(Number) as unknown,
  });

  expect(parsed).toStrictEqual(call);
});

test('it applies overrides on top of the defaults', () => {
  const call: unknown = buildMockApiCall({ actor: 'dashboard', outcome: 'NOT_FOUND' });

  expect(call).toStrictEqual({
    at: expect.toBeValidDate() as unknown,
    procedure: expect.toBeOneOf(['imps.stop', 'imps.start', 'imps.create']) as unknown,
    actor: 'dashboard',
    actorName: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    imp: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    outcome: 'NOT_FOUND',
    durationMs: expect.any(Number) as unknown,
  });
});
