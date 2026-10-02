import { expect, test } from 'bun:test';
import { buildLeasedError } from '../api-errors';
import type { LeaseRecord } from '../db/leases';
import { toCallerError, toLeaseSummary } from './caller-view';
import { buildTestCaller } from './test-callers';

const AT = new Date(1_800_000_000_000);

function buildLease(principal: string, label = 'job'): LeaseRecord {
  return { impId: 'i', principal, label, display: principal, until: AT, createdAt: AT };
}

const LEASES = [buildLease('token:a'), buildLease('token:b'), buildLease('legacy', 'hold')];

test('a caller sees its own leases; host-wide manage sees every owner', () => {
  const own = toLeaseSummary(
    buildTestCaller({ scope: 'exec', principal: 'token:a' }),
    'dev',
    LEASES,
  );

  const limitedManage = toLeaseSummary(
    buildTestCaller({ principal: 'token:c', imps: ['dev'] }),
    'dev',
    LEASES,
  );

  const host = toLeaseSummary(buildTestCaller({ principal: 'token:c' }), 'dev', LEASES);

  expect(own.leases.map((lease) => lease.owner.principal)).toEqual(['token:a']);
  expect(own.otherCount).toBe(2);
  expect(limitedManage).toEqual({ leases: [], otherCount: 3 });
  expect(host.leases).toHaveLength(3);
  expect(host.otherCount).toBe(0);
});

test('an event reader sees counts only', () => {
  expect(toLeaseSummary(null, 'dev', LEASES)).toEqual({ leases: [], otherCount: 3 });

  expect(toCallerError(buildLeasedError('dev', LEASES), null)).toMatchObject({
    data: { leases: [], otherCount: 3 },
  });
});

test('LEASED leaves impd as counts, and the view adds the caller’s own', () => {
  const error = buildLeasedError('dev', LEASES);
  const caller = buildTestCaller({ scope: 'exec', principal: 'token:b' });

  expect(error.data).toEqual({ leases: [], otherCount: 3 });

  expect(toCallerError(error, caller)).toMatchObject({
    code: 'LEASED',
    status: 409,
    data: { leases: [{ name: 'dev', owner: { principal: 'token:b' } }], otherCount: 2 },
  });
});

test('an error with nothing to hide passes as it is', () => {
  const error = new Error('boom');

  expect(toCallerError(error, buildTestCaller())).toBe(error);
});
