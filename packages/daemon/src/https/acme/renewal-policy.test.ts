import { expect, test } from 'bun:test';
import { planRenewal, readBackoffMs } from './renewal-policy';

const DAY = 86_400_000;
const DOMAIN = 'imp.example.com';
const NAMES = ['imp.example.com', '*.imp.example.com'];
const ISSUED = Date.UTC(2026, 0, 1);
const NO_ATTEMPTS = { failures: 0, lastAttemptAt: null, lastError: null };

function buildInfo(names: readonly string[] = NAMES) {
  return { notBefore: new Date(ISSUED), notAfter: new Date(ISSUED + 90 * DAY), names };
}

test('a fresh certificate for both names is kept', () => {
  expect(
    planRenewal({
      info: buildInfo(),
      domain: DOMAIN,
      attempts: NO_ATTEMPTS,
      now: ISSUED + 59 * DAY,
    }),
  ).toEqual({ kind: 'keep' });
});

test('a certificate two thirds through its life is renewed', () => {
  const decision = planRenewal({
    info: buildInfo(),
    domain: DOMAIN,
    attempts: NO_ATTEMPTS,
    now: ISSUED + 61 * DAY,
  });

  expect(decision.kind).toBe('issue');
});

test('no certificate, a missing name or an expired one is issued', () => {
  const now = ISSUED + DAY;

  expect(planRenewal({ info: null, domain: DOMAIN, attempts: NO_ATTEMPTS, now })).toEqual({
    kind: 'issue',
    reason: 'there is no certificate',
  });

  expect(
    planRenewal({
      info: buildInfo(['imp.example.com']),
      domain: DOMAIN,
      attempts: NO_ATTEMPTS,
      now,
    }),
  ).toEqual({ kind: 'issue', reason: 'the certificate does not cover *.imp.example.com' });

  expect(
    planRenewal({
      info: buildInfo(),
      domain: DOMAIN,
      attempts: NO_ATTEMPTS,
      now: ISSUED + 91 * DAY,
    }),
  ).toEqual({ kind: 'issue', reason: 'the certificate has expired' });
});

test('failed attempts back off, doubling up to a day', () => {
  expect([0, 1, 2, 3, 10].map((failures) => readBackoffMs(failures) / 60_000)).toEqual([
    0, 15, 30, 60, 1440,
  ]);

  const lastAttemptAt = ISSUED;
  const attempts = { failures: 2, lastAttemptAt, lastError: 'boom' };

  expect(
    planRenewal({ info: null, domain: DOMAIN, attempts, now: lastAttemptAt + 29 * 60_000 }),
  ).toEqual({
    kind: 'wait',
    reason: 'there is no certificate',
    until: lastAttemptAt + 30 * 60_000,
  });

  expect(
    planRenewal({ info: null, domain: DOMAIN, attempts, now: lastAttemptAt + 30 * 60_000 }).kind,
  ).toBe('issue');
});
