import { expect, test } from 'bun:test';
import {
  LeaseLabelSchema,
  LeaseOwnerSchema,
  LeaseSchema,
  LeaseSummarySchema,
  LeaseTtlSchema,
} from './lease-schema';

test.each([
  'hold',
  'ci:job_1.retry-2',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])('#LeaseLabelSchema accepts the label %s', (input) => {
  expect(LeaseLabelSchema.safeParse(input).data).toBe(input);
});

test.each([
  '',
  'has space',
  'a/b',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])('#LeaseLabelSchema rejects the label %s', (input) => {
  const result = LeaseLabelSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: [],
      message: 'must be 1–64 letters, digits, dots, underscores, colons or hyphens',
    }),
  );
});

test.each([10, 600, 3600])('#LeaseTtlSchema accepts %d seconds', (input) => {
  expect(LeaseTtlSchema.safeParse(input).data).toBe(input);
});

test.each([9, 3601, 10.5])('#LeaseTtlSchema rejects %d seconds', (input) => {
  const result = LeaseTtlSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#LeaseOwnerSchema accepts an owner', () => {
  const payload = { principal: 'token:1', display: 'laptop', label: 'hold' } as const;

  expect(LeaseOwnerSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#LeaseSchema accepts a lease with an end', () => {
  const payload = {
    name: 'dev',
    owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
    until: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  expect(LeaseSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#LeaseSchema accepts a lease with no end', () => {
  const payload = {
    name: 'dev',
    owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
    until: null,
  } as const;

  expect(LeaseSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#LeaseSchema rejects a name that is not a valid name', () => {
  const result = LeaseSchema.safeParse({
    name: 'Dev',
    owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
    until: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['name'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#LeaseSummarySchema accepts leases and a count of others', () => {
  const payload = {
    leases: [
      {
        name: 'dev',
        owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: 2,
  } as const;

  expect(LeaseSummarySchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#LeaseSummarySchema rejects a negative count of others', () => {
  const result = LeaseSummarySchema.safeParse({
    leases: [
      {
        name: 'dev',
        owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: -1,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['otherCount'] }),
  );
});

test('#LeaseSummarySchema rejects a fractional count of others', () => {
  const result = LeaseSummarySchema.safeParse({
    leases: [
      {
        name: 'dev',
        owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: 1.5,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['otherCount'] }),
  );
});

test('#LeaseSummarySchema rejects a lease that is not a valid lease', () => {
  const result = LeaseSummarySchema.safeParse({
    leases: [
      {
        name: 'Dev',
        owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: 2,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['leases', 0, 'name'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});
