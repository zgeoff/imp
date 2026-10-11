import { expect, test } from 'bun:test';
import { buildMockNewAuditEntry } from './build-mock-new-audit-entry';

test('it builds a default new audit entry', () => {
  expect(buildMockNewAuditEntry()).toStrictEqual({
    impId: expect.toBeString() as unknown,
    secretName: expect.toBeString() as unknown,
    at: expect.toBeValidDate() as unknown,
    method: 'GET',
    host: expect.toBeString() as unknown,
    path: expect.toStartWith('/') as unknown,
    status: 200,
    requestBytes: expect.toBeWithin(0, 1024 ** 2 + 1) as unknown,
    responseBytes: expect.toBeWithin(0, 1024 ** 2 + 1) as unknown,
    durationMs: expect.toBeWithin(0, 60_001) as unknown,
  });
});

test('it applies overrides on top of the defaults', () => {
  const entry = buildMockNewAuditEntry({
    impId: 'imp-1',
    secretName: 'gh',
    at: new Date(Date.UTC(2026, 0, 1)),
    method: 'POST',
    host: 'api.github.com',
    path: '/user',
    status: 403,
    requestBytes: 17,
    responseBytes: 42,
    durationMs: 5,
  });

  expect(entry).toStrictEqual({
    impId: 'imp-1',
    secretName: 'gh',
    at: new Date(Date.UTC(2026, 0, 1)),
    method: 'POST',
    host: 'api.github.com',
    path: '/user',
    status: 403,
    requestBytes: 17,
    responseBytes: 42,
    durationMs: 5,
  });
});
