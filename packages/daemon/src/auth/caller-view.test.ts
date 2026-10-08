import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/server';
import { buildLeasedError, buildRamBudgetError } from '../api-errors';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { buildMockLeaseRecord } from '../test-utils/build-mock-lease-record';
import {
  isLeaseVisible,
  requireLeaseHolder,
  toApiLease,
  toCallerError,
  toLeaseSummary,
} from './caller-view';

test('#requireLeaseHolder names the caller’s principal and display as the lease owner', () => {
  const caller = buildMockCaller();

  expect(requireLeaseHolder(caller)).toStrictEqual({
    principal: String(caller.principal),
    display: caller.display,
  });
});

test('#requireLeaseHolder refuses a caller with no stable identity', () => {
  const node = buildMockCaller({ kind: 'tailnet', name: 'runner', principal: null, scope: 'exec' });

  expect(() => requireLeaseHolder(node)).toThrow(
    expect.objectContaining({
      code: 'FORBIDDEN',
      message: 'tailnet runner has no stable identity, so it cannot hold a lease; use a token',
    }),
  );
});

test('#toApiLease gives a lease record as the API shows it', () => {
  const until = new Date(1_800_000_060_000);

  const lease = toApiLease(
    'dev',
    buildMockLeaseRecord({
      principal: 'token:a',
      label: 'job',
      display: 'ci',
      until,
    }),
  );

  expect(lease).toStrictEqual({
    name: 'dev',
    owner: { principal: 'token:a', display: 'ci', label: 'job' },
    until,
  });
});

test('#isLeaseVisible shows a caller its own lease', () => {
  const caller = buildMockCaller({ scope: 'exec' });

  const visible = isLeaseVisible(
    caller,
    buildMockLeaseRecord({
      principal: String(caller.principal),
      label: 'job',
      display: caller.display,
    }),
  );

  expect(visible).toBeTrue();
});

test('#isLeaseVisible hides another owner’s lease from an exec caller', () => {
  const visible = isLeaseVisible(
    buildMockCaller({ scope: 'exec' }),
    buildMockLeaseRecord({
      principal: 'token:other',
      label: 'job',
      display: 'other',
    }),
  );

  expect(visible).toBeFalse();
});

test('#isLeaseVisible hides another owner’s lease from a manage caller limited to some imps', () => {
  const visible = isLeaseVisible(
    buildMockCaller({ imps: ['dev'] }),
    buildMockLeaseRecord({
      principal: 'token:other',
      label: 'job',
      display: 'other',
    }),
  );

  expect(visible).toBeFalse();
});

test('#isLeaseVisible shows another owner’s lease to a host-wide manage caller', () => {
  const visible = isLeaseVisible(
    buildMockCaller(),
    buildMockLeaseRecord({
      principal: 'token:other',
      label: 'job',
      display: 'other',
    }),
  );

  expect(visible).toBeTrue();
});

test('#isLeaseVisible hides every lease from an event’s reader', () => {
  const visible = isLeaseVisible(
    null,
    buildMockLeaseRecord({
      principal: 'token:other',
      label: 'job',
      display: 'other',
    }),
  );

  expect(visible).toBeFalse();
});

test('#toLeaseSummary shows a caller its own leases and counts the others', () => {
  const caller = buildMockCaller({ scope: 'exec' });

  const summary = toLeaseSummary(caller, 'dev', [
    buildMockLeaseRecord({
      principal: String(caller.principal),
      label: 'job',
      display: caller.display,
    }),
    buildMockLeaseRecord({
      principal: 'token:other',
      label: 'job',
      display: 'other',
    }),
    buildMockLeaseRecord({
      principal: 'legacy',
      label: 'hold',
      display: 'legacy',
    }),
  ]);

  expect(summary).toStrictEqual({
    leases: [
      {
        name: 'dev',
        owner: { principal: String(caller.principal), display: caller.display, label: 'job' },
        until: null,
      },
    ],
    otherCount: 2,
  });
});

test('#toLeaseSummary counts every lease for an event’s reader', () => {
  const summary = toLeaseSummary(null, 'dev', [
    buildMockLeaseRecord({
      principal: 'token:a',
      label: 'job',
      display: 'a',
    }),
  ]);

  expect(summary).toStrictEqual({ leases: [], otherCount: 1 });
});

test('#toLeaseSummary counts every lease for a caller with no stable identity', () => {
  const node = buildMockCaller({ kind: 'tailnet', name: 'runner', principal: null, scope: 'exec' });

  const summary = toLeaseSummary(node, 'dev', [
    buildMockLeaseRecord({ principal: 'token:a' }),
    buildMockLeaseRecord({ principal: 'legacy', label: 'hold' }),
  ]);

  expect(summary).toStrictEqual({ leases: [], otherCount: 2 });
});

test('#toLeaseSummary counts another owner’s leases for a manage caller limited to some imps', () => {
  const summary = toLeaseSummary(buildMockCaller({ imps: ['dev'] }), 'dev', [
    buildMockLeaseRecord({ principal: 'token:a' }),
    buildMockLeaseRecord({ principal: 'legacy', label: 'hold' }),
  ]);

  expect(summary).toStrictEqual({ leases: [], otherCount: 2 });
});

test('#toLeaseSummary shows every owner’s lease to a host-wide manage caller', () => {
  const summary = toLeaseSummary(buildMockCaller(), 'dev', [
    buildMockLeaseRecord({ principal: 'token:a', label: 'job', display: 'a' }),
    buildMockLeaseRecord({ principal: 'legacy', label: 'hold', display: 'legacy' }),
  ]);

  expect(summary).toStrictEqual({
    leases: [
      { name: 'dev', owner: { principal: 'token:a', display: 'a', label: 'job' }, until: null },
      {
        name: 'dev',
        owner: { principal: 'legacy', display: 'legacy', label: 'hold' },
        until: null,
      },
    ],
    otherCount: 0,
  });
});

test('#toCallerError gives an event’s reader a LEASED error with counts only', () => {
  const error = buildLeasedError('dev', [
    buildMockLeaseRecord({
      principal: 'token:a',
      label: 'job',
      display: 'a',
    }),
  ]);

  expect(toCallerError(error, null)).toMatchObject({
    code: 'LEASED',
    status: 409,
    data: { leases: [], otherCount: 1 },
  });
});

test('#toCallerError adds the caller’s own leases to a LEASED error that left impd as counts', () => {
  const caller = buildMockCaller({ scope: 'exec' });

  const error = buildLeasedError('dev', [
    buildMockLeaseRecord({
      principal: String(caller.principal),
      label: 'job',
      display: caller.display,
    }),
    buildMockLeaseRecord({
      principal: 'token:other',
      label: 'job',
      display: 'other',
    }),
  ]);

  const shown = toCallerError(error, caller);

  expect(error.data).toStrictEqual({ leases: [], otherCount: 2 });
  expect(shown).toBeInstanceOf(ORPCError);

  expect(shown).toMatchObject({
    code: 'LEASED',
    status: 409,
    message: error.message,
    data: {
      leases: [
        {
          name: 'dev',
          owner: { principal: caller.principal, display: caller.display, label: 'job' },
          until: null,
        },
      ],
      otherCount: 1,
    },
  });
});

test('#toCallerError shows a caller the protected imps it may read, and counts the rest', () => {
  const caller = buildMockCaller({ scope: 'read', imps: ['dev-*'] });

  const error = buildRamBudgetError({
    budgetMib: 4096,
    usedMib: 4000,
    requestedMib: 512,
    protected: [
      { name: 'dev-a', ramMib: 1024, leased: true, busy: false },
      { name: 'prod', ramMib: 2048, leased: false, busy: true },
    ],
  });

  expect(toCallerError(error, caller)).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: {
      neededMib: 416,
      protected: [{ name: 'dev-a', ramMib: 1024, leased: true, busy: false }],
      protectedHidden: 1,
    },
  });
});

test('#toCallerError hides every protected imp from an event’s reader', () => {
  const error = buildRamBudgetError({
    budgetMib: 4096,
    usedMib: 4000,
    requestedMib: 512,
    protected: [{ name: 'dev-a', ramMib: 1024, leased: true, busy: false }],
  });

  expect(toCallerError(error, null)).toMatchObject({
    data: { protected: [], protectedHidden: 1 },
  });
});

test('#toCallerError passes an error with nothing to hide as it is', () => {
  const error = new Error('boom');

  expect(toCallerError(error, buildMockCaller())).toBe(error);
});
