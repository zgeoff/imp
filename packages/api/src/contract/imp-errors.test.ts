import { expect, test } from 'bun:test';
import * as z from 'zod';
import { IMP_ERRORS } from './imp-errors';

test('#NOT_FOUND carries its message, no status of its own and a data schema', () => {
  const error: unknown = IMP_ERRORS.NOT_FOUND;

  expect(error).toStrictEqual({
    message: 'Not found',
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#NOT_FOUND accepts a resource with its kind and name', () => {
  const payload = { kind: 'imp', name: 'dev' } as const;

  expect(IMP_ERRORS.NOT_FOUND.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#NOT_FOUND accepts a resource with a reason', () => {
  const payload = { kind: 'secret', name: 'github-token', reason: 'binding_changed' } as const;

  expect(IMP_ERRORS.NOT_FOUND.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#NOT_FOUND rejects a kind outside the list', () => {
  const result = IMP_ERRORS.NOT_FOUND.data.safeParse({
    kind: 'volume',
    name: 'dev',
    reason: 'binding_changed',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_value' });
});

test('#NOT_FOUND rejects a reason outside the list', () => {
  const result = IMP_ERRORS.NOT_FOUND.data.safeParse({
    kind: 'secret',
    name: 'github-token',
    reason: 'renamed',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#CONFLICT carries its message, no status of its own and a data schema', () => {
  const error: unknown = IMP_ERRORS.CONFLICT;

  expect(error).toStrictEqual({
    message: 'Already exists',
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#CONFLICT accepts a resource with its kind and name', () => {
  const payload = { kind: 'oauth-client', name: 'tools' } as const;

  expect(IMP_ERRORS.CONFLICT.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#CONFLICT rejects a kind outside the list', () => {
  const result = IMP_ERRORS.CONFLICT.data.safeParse({ kind: 'volume', name: 'tools' });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_value' });
});

test('#FORBIDDEN carries its message, no status of its own and a data schema', () => {
  const error: unknown = IMP_ERRORS.FORBIDDEN;

  expect(error).toStrictEqual({
    message: 'Not allowed',
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#FORBIDDEN accepts no data', () => {
  expect(IMP_ERRORS.FORBIDDEN.data.safeParse(undefined)).toStrictEqual({
    success: true,
    data: undefined,
  });
});

test('#FORBIDDEN accepts a reason', () => {
  const payload = { reason: 'not_grantable' } as const;

  expect(IMP_ERRORS.FORBIDDEN.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#FORBIDDEN rejects a reason outside the list', () => {
  const result = IMP_ERRORS.FORBIDDEN.data.safeParse({ reason: 'banned' });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#PRECONDITION_FAILED carries its message, no status of its own and a data schema', () => {
  const error: unknown = IMP_ERRORS.PRECONDITION_FAILED;

  expect(error).toStrictEqual({
    message: 'Not possible on this host',
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#PRECONDITION_FAILED accepts no data', () => {
  expect(IMP_ERRORS.PRECONDITION_FAILED.data.safeParse(undefined)).toStrictEqual({
    success: true,
    data: undefined,
  });
});

test('#PRECONDITION_FAILED accepts an exec requirement the broker was not ready for', () => {
  const payload = { reason: 'broker_not_ready', detail: 'the broker is starting' } as const;

  expect(IMP_ERRORS.PRECONDITION_FAILED.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#PRECONDITION_FAILED rejects a reason outside the list', () => {
  const result = IMP_ERRORS.PRECONDITION_FAILED.data.safeParse({
    reason: 'no_disk',
    detail: 'the broker is starting',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#RAM_BUDGET_EXCEEDED carries its message, status 503 and a data schema', () => {
  const error: unknown = IMP_ERRORS.RAM_BUDGET_EXCEEDED;

  expect(error).toStrictEqual({
    message: 'Not enough RAM budget, even after sleeping idle imps',
    status: 503,
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#RAM_BUDGET_EXCEEDED accepts the budget with the imps it could not sleep', () => {
  const payload = {
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: 1024,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  } as const;

  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#RAM_BUDGET_EXCEEDED accepts the budget alone from an impd before leases', () => {
  const payload = { budgetMib: 8192, usedMib: 7680, requestedMib: 1024 } as const;

  expect(IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#RAM_BUDGET_EXCEEDED rejects a negative budget', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: -1,
    usedMib: 7680,
    requestedMib: 1024,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['budgetMib'], code: 'too_small' });
});

test('#RAM_BUDGET_EXCEEDED rejects a negative used RAM', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: -1,
    requestedMib: 1024,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['usedMib'], code: 'too_small' });
});

test('#RAM_BUDGET_EXCEEDED rejects a negative requested RAM', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: -1,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['requestedMib'], code: 'too_small' });
});

test('#RAM_BUDGET_EXCEEDED rejects a negative missing RAM', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: 1024,
    neededMib: -1,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['neededMib'], code: 'too_small' });
});

test('#RAM_BUDGET_EXCEEDED rejects a negative count of hidden imps', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: 1024,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['protectedHidden'], code: 'too_small' });
});

test('#RAM_BUDGET_EXCEEDED rejects a fractional requested RAM', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: 10.5,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['requestedMib'], code: 'invalid_type' });
});

test('#RAM_BUDGET_EXCEEDED rejects a protected imp with a name that is not a name', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: 1024,
    neededMib: 512,
    protected: [{ name: 'Dev', ramMib: 2048, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['protected', 0, 'name'],
    code: 'invalid_format',
  });
});

test('#RAM_BUDGET_EXCEEDED rejects a protected imp with negative RAM', () => {
  const result = IMP_ERRORS.RAM_BUDGET_EXCEEDED.data.safeParse({
    budgetMib: 8192,
    usedMib: 7680,
    requestedMib: 1024,
    neededMib: 512,
    protected: [{ name: 'dev', ramMib: -1, leased: true, busy: false }],
    protectedHidden: 1,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['protected', 0, 'ramMib'],
    code: 'too_small',
  });
});

test('#SERVICE_UNAVAILABLE carries its message, no status of its own', () => {
  expect(IMP_ERRORS.SERVICE_UNAVAILABLE).toStrictEqual({ message: 'impd is stopping' });
});

test('#INVALID_STATE carries its message, status 409 and a data schema', () => {
  const error: unknown = IMP_ERRORS.INVALID_STATE;

  expect(error).toStrictEqual({
    message: 'The imp is not in a state that allows this',
    status: 409,
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#INVALID_STATE accepts the state with the allowed states and cold boots', () => {
  const payload: z.input<typeof IMP_ERRORS.INVALID_STATE.data> = {
    state: 'sleeping',
    allowed: ['running'],
    coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-01-02T03:04:05.000Z' }],
  };

  const result = IMP_ERRORS.INVALID_STATE.data.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#INVALID_STATE rejects a state outside the imp states', () => {
  const result = IMP_ERRORS.INVALID_STATE.data.safeParse({
    state: 'napping',
    allowed: ['running'],
    coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-01-02T03:04:05.000Z' }],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['state'], code: 'invalid_value' });
});

test('#INVALID_STATE rejects an allowed state outside the imp states', () => {
  const result = IMP_ERRORS.INVALID_STATE.data.safeParse({
    state: 'sleeping',
    allowed: ['napping'],
    coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-01-02T03:04:05.000Z' }],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['allowed', 0], code: 'invalid_value' });
});

test('#INVALID_STATE rejects a cold boot of an unknown cause', () => {
  const result = IMP_ERRORS.INVALID_STATE.data.safeParse({
    state: 'sleeping',
    allowed: ['running'],
    coldBoots: [{ bootId: 'boot-1', cause: 'crash', at: '2026-01-02T03:04:05.000Z' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['coldBoots', 0, 'cause'],
    code: 'invalid_value',
  });
});

test('#INVALID_RESUME carries its message, status 409 and a data schema', () => {
  const error: unknown = IMP_ERRORS.INVALID_RESUME;

  expect(error).toStrictEqual({
    message: 'The resume offset is past the end of the output',
    status: 409,
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#INVALID_RESUME accepts the end and buffer start', () => {
  const payload = { end: 4096, bufferStart: 1024 } as const;

  expect(IMP_ERRORS.INVALID_RESUME.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#INVALID_RESUME rejects a negative end', () => {
  const result = IMP_ERRORS.INVALID_RESUME.data.safeParse({ end: -1, bufferStart: 1024 });

  expect(result.error?.issues).toPartiallyContain({ path: ['end'], code: 'too_small' });
});

test('#INVALID_RESUME rejects a negative buffer start', () => {
  const result = IMP_ERRORS.INVALID_RESUME.data.safeParse({ end: 4096, bufferStart: -1 });

  expect(result.error?.issues).toPartiallyContain({ path: ['bufferStart'], code: 'too_small' });
});

test('#DISK_FULL carries its message, status 507 and a data schema', () => {
  const error: unknown = IMP_ERRORS.DISK_FULL;

  expect(error).toStrictEqual({
    message: 'Not enough free disk on the host',
    status: 507,
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#DISK_FULL accepts the free space, reserve and request', () => {
  const payload = { availableBytes: 1024, reserveBytes: 2048, requestedBytes: 4096 } as const;

  expect(IMP_ERRORS.DISK_FULL.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#DISK_FULL rejects a negative free space', () => {
  const result = IMP_ERRORS.DISK_FULL.data.safeParse({
    availableBytes: -1,
    reserveBytes: 2048,
    requestedBytes: 4096,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['availableBytes'], code: 'too_small' });
});

test('#DISK_FULL rejects a negative reserve', () => {
  const result = IMP_ERRORS.DISK_FULL.data.safeParse({
    availableBytes: 1024,
    reserveBytes: -1,
    requestedBytes: 4096,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reserveBytes'], code: 'too_small' });
});

test('#DISK_FULL rejects a negative request', () => {
  const result = IMP_ERRORS.DISK_FULL.data.safeParse({
    availableBytes: 1024,
    reserveBytes: 2048,
    requestedBytes: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['requestedBytes'], code: 'too_small' });
});

test('#LEASED carries its message, status 409 and a data schema', () => {
  const error: unknown = IMP_ERRORS.LEASED;

  expect(error).toStrictEqual({
    message: 'The imp is leased',
    status: 409,
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#LEASED accepts the leases the caller may see and the count of others', () => {
  const payload = {
    leases: [
      {
        name: 'dev',
        owner: { principal: 'token:ci', display: 'ci', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: 2,
  } as const;

  const result = IMP_ERRORS.LEASED.data.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#LEASED rejects a lease on a name that is not a name', () => {
  const result = IMP_ERRORS.LEASED.data.safeParse({
    leases: [
      {
        name: 'Dev',
        owner: { principal: 'token:ci', display: 'ci', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: 2,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['leases', 0, 'name'],
    code: 'invalid_format',
  });
});

test('#LEASED rejects a lease end that is not a date', () => {
  const result = IMP_ERRORS.LEASED.data.safeParse({
    leases: [
      {
        name: 'dev',
        owner: { principal: 'token:ci', display: 'ci', label: 'hold' },
        until: '2026-01-02T03:04:05.000Z',
      },
    ],
    otherCount: 2,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['leases', 0, 'until'],
    code: 'invalid_type',
  });
});

test('#LEASED rejects a negative count of other leases', () => {
  const result = IMP_ERRORS.LEASED.data.safeParse({
    leases: [
      {
        name: 'dev',
        owner: { principal: 'token:ci', display: 'ci', label: 'hold' },
        until: new Date('2026-01-02T03:04:05.000Z'),
      },
    ],
    otherCount: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['otherCount'], code: 'too_small' });
});

test('#LEASE_NOT_HELD carries its message, status 409', () => {
  expect(IMP_ERRORS.LEASE_NOT_HELD).toStrictEqual({
    message: 'The caller holds no such lease',
    status: 409,
  });
});

test('#AGENT_OUTDATED carries its message, status 409', () => {
  expect(IMP_ERRORS.AGENT_OUTDATED).toStrictEqual({
    message: "The imp's agent is too old for this",
    status: 409,
  });
});

test('#MOVING carries its message, status 409 and a data schema', () => {
  const error: unknown = IMP_ERRORS.MOVING;

  expect(error).toStrictEqual({
    message: 'The imp is moving between hosts',
    status: 409,
    data: expect.any(z.ZodType) as unknown,
  });
});

test('#MOVING accepts a retry delay', () => {
  const payload = { retryAfterS: 5 } as const;

  expect(IMP_ERRORS.MOVING.data.safeParse(payload).data).toStrictEqual(payload);
});

test('#MOVING rejects a retry delay of zero', () => {
  const result = IMP_ERRORS.MOVING.data.safeParse({ retryAfterS: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['retryAfterS'], code: 'too_small' });
});

test('#IMP_ERRORS declares exactly these error codes, in this order', () => {
  expect(Object.keys(IMP_ERRORS)).toStrictEqual([
    'NOT_FOUND',
    'CONFLICT',
    'FORBIDDEN',
    'PRECONDITION_FAILED',
    'RAM_BUDGET_EXCEEDED',
    'SERVICE_UNAVAILABLE',
    'INVALID_STATE',
    'INVALID_RESUME',
    'DISK_FULL',
    'LEASED',
    'LEASE_NOT_HELD',
    'AGENT_OUTDATED',
    'MOVING',
  ]);
});
