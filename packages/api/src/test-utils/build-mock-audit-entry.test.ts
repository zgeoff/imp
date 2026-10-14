import { expect, test } from 'bun:test';
import { AuditEntrySchema } from '../schemas/secret-schema';
import { buildMockAuditEntry } from './build-mock-audit-entry';

test('it builds a default audit entry', () => {
  const entry = buildMockAuditEntry();
  const parsed: unknown = AuditEntrySchema.safeParse(entry).data;
  const received: unknown = entry;

  expect(received).toStrictEqual({
    at: expect.toBeValidDate() as unknown,
    imp: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    secret: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    method: 'GET',
    host: expect.toBeString() as unknown,
    path: expect.toStartWith('/') as unknown,
    status: 200,
    requestBytes: expect.toBeWithin(0, 1024 ** 2 + 1) as unknown,
    responseBytes: expect.toBeWithin(0, 1024 ** 2 + 1) as unknown,
    durationMs: expect.toBeWithin(0, 60_001) as unknown,
    reason: null,
  });

  expect(parsed).toStrictEqual(entry);
});

test('it applies overrides on top of the defaults', () => {
  const entry: unknown = buildMockAuditEntry({
    secret: null,
    method: 'CONNECT',
    host: 'example.com',
    path: null,
    status: 403,
    reason: 'egress-policy',
  });

  expect(entry).toStrictEqual({
    at: expect.toBeValidDate() as unknown,
    imp: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    secret: null,
    method: 'CONNECT',
    host: 'example.com',
    path: null,
    status: 403,
    requestBytes: expect.toBeWithin(0, 1024 ** 2 + 1) as unknown,
    responseBytes: expect.toBeWithin(0, 1024 ** 2 + 1) as unknown,
    durationMs: expect.toBeWithin(0, 60_001) as unknown,
    reason: 'egress-policy',
  });
});
