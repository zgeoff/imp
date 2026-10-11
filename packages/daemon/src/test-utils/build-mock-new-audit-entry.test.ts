import { expect, test } from 'bun:test';
import { buildMockNewAuditEntry } from './build-mock-new-audit-entry';

test('it builds a default new audit entry', () => {
  expect(buildMockNewAuditEntry()).toStrictEqual({
    impId: expect.toBeString(),
    secretName: expect.toBeString(),
    at: expect.toBeValidDate(),
    method: 'GET',
    host: expect.toBeString(),
    path: expect.toStartWith('/'),
    status: 200,
    requestBytes: expect.toBeWithin(0, 1024 ** 2 + 1),
    responseBytes: expect.toBeWithin(0, 1024 ** 2 + 1),
    durationMs: expect.toBeWithin(0, 60_001),
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
