import { expect, test } from 'bun:test';
import { NetworkJoinSchema, NetworkSchema } from './network-schema';

test('#NetworkSchema accepts a network', () => {
  const payload = {
    name: 'lab',
    imps: ['api', 'web'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  expect(NetworkSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#NetworkSchema rejects a name that is not a valid name', () => {
  const result = NetworkSchema.safeParse({
    name: 'Lab',
    imps: ['api', 'web'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['name'],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test('#NetworkSchema rejects an imp that is not a valid name', () => {
  const result = NetworkSchema.safeParse({
    name: 'lab',
    imps: ['api', 'Web'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['imps', 1],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test('#NetworkJoinSchema accepts a join without a warning', () => {
  const payload = {
    name: 'lab',
    imps: ['api', 'web'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    warning: null,
  } as const;

  expect(NetworkJoinSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#NetworkJoinSchema accepts a join with a warning', () => {
  const payload = {
    name: 'lab',
    imps: ['api', 'web'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    warning: 'web reaches the internet and can relay for api',
  } as const;

  expect(NetworkJoinSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#NetworkJoinSchema rejects an imp that is not a valid name', () => {
  const result = NetworkJoinSchema.safeParse({
    name: 'lab',
    imps: ['Api', 'web'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    warning: null,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['imps', 0],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});
