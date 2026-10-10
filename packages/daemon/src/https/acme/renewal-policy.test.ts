import { expect, test } from 'bun:test';
import { listCertificateNames, planRenewal, readBackoffMs } from './renewal-policy';

test('it keeps a certificate for both names a third of the way short of expiry', () => {
  expect(
    planRenewal({
      info: {
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2026-04-01T00:00:00Z'),
        names: ['imp.example.com', '*.imp.example.com'],
      },
      domain: 'imp.example.com',
      attempts: { failures: 0, lastAttemptAt: null, lastError: null },
      now: Date.parse('2026-03-01T00:00:00Z'),
    }),
  ).toStrictEqual({ kind: 'keep' });
});

test('it renews a certificate two thirds through its life, naming its expiry', () => {
  expect(
    planRenewal({
      info: {
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2026-04-01T00:00:00Z'),
        names: ['imp.example.com', '*.imp.example.com'],
      },
      domain: 'imp.example.com',
      attempts: { failures: 0, lastAttemptAt: null, lastError: null },
      now: Date.parse('2026-03-02T00:00:00Z'),
    }),
  ).toStrictEqual({
    kind: 'issue',
    reason: 'the certificate expires 2026-04-01T00:00:00.000Z',
  });
});

test('it issues a certificate when there is none', () => {
  expect(
    planRenewal({
      info: null,
      domain: 'imp.example.com',
      attempts: { failures: 0, lastAttemptAt: null, lastError: null },
      now: Date.parse('2026-01-02T00:00:00Z'),
    }),
  ).toStrictEqual({ kind: 'issue', reason: 'there is no certificate' });
});

test('it issues a certificate when the one on disk misses a name', () => {
  expect(
    planRenewal({
      info: {
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2026-04-01T00:00:00Z'),
        names: ['imp.example.com'],
      },
      domain: 'imp.example.com',
      attempts: { failures: 0, lastAttemptAt: null, lastError: null },
      now: Date.parse('2026-01-02T00:00:00Z'),
    }),
  ).toStrictEqual({ kind: 'issue', reason: 'the certificate does not cover *.imp.example.com' });
});

test('it issues a certificate when the one on disk has expired', () => {
  expect(
    planRenewal({
      info: {
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2026-04-01T00:00:00Z'),
        names: ['imp.example.com', '*.imp.example.com'],
      },
      domain: 'imp.example.com',
      attempts: { failures: 0, lastAttemptAt: null, lastError: null },
      now: Date.parse('2026-04-02T00:00:00Z'),
    }),
  ).toStrictEqual({ kind: 'issue', reason: 'the certificate has expired' });
});

test.each([
  [0, 0],
  [1, 15],
  [2, 30],
  [3, 60],
  [10, 1440],
])('it backs off %d failed attempts by %d minutes', (failures, minutes) => {
  expect(readBackoffMs(failures)).toBe(minutes * 60_000);
});

test('it waits out the backoff after failed attempts, with the reason', () => {
  expect(
    planRenewal({
      info: null,
      domain: 'imp.example.com',
      attempts: { failures: 2, lastAttemptAt: Date.parse('2026-01-01T00:00:00Z'), lastError: 'x' },
      now: Date.parse('2026-01-01T00:29:00Z'),
    }),
  ).toStrictEqual({
    kind: 'wait',
    reason: 'there is no certificate',
    until: Date.parse('2026-01-01T00:30:00Z'),
  });
});

test('it issues again once the backoff has passed', () => {
  expect(
    planRenewal({
      info: null,
      domain: 'imp.example.com',
      attempts: { failures: 2, lastAttemptAt: Date.parse('2026-01-01T00:00:00Z'), lastError: 'x' },
      now: Date.parse('2026-01-01T00:30:00Z'),
    }),
  ).toStrictEqual({ kind: 'issue', reason: 'there is no certificate' });
});

test('it names the domain and its wildcard for one certificate', () => {
  expect(listCertificateNames('imp.example.com')).toStrictEqual([
    'imp.example.com',
    '*.imp.example.com',
  ]);
});
