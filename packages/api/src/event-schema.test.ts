import { expect, test } from 'bun:test';
import * as z from 'zod';
import { ImpChangeReasonSchema, ImpEventDetailSchema, ImpEventSchema } from './event-schema';

test('#ImpEventDetailSchema keeps prepareMs in a slept detail', () => {
  const result = ImpEventDetailSchema.safeParse({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: 240,
    steps: { pause: 1, snapshot: 700 },
  });

  expect(result.data).toStrictEqual({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: 240,
    steps: { pause: 1, snapshot: 700 },
  });
});

test('#ImpEventDetailSchema rejects a negative prepareMs', () => {
  const result = ImpEventDetailSchema.safeParse({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: -1,
    steps: { pause: 1, snapshot: 700 },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['prepareMs'], code: 'too_small' });
});

test('#ImpEventDetailSchema sends prepareMs in a detail that a client from before prepareMs still parses', () => {
  // ImpEventDetailSchema as it was before prepareMs
  const oldDetailSchema = z
    .object({
      durationMs: z.int().nonnegative().optional(),
      trigger: z.string().optional(),
      coldBootReason: z.string().optional(),
      steps: z.record(z.string(), z.int()).readonly().optional(),
      released: z.int().positive().optional(),
    })
    .readonly();

  const detail = ImpEventDetailSchema.parse({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: 240,
    steps: { pause: 1, snapshot: 700 },
  });

  const result = oldDetailSchema.safeParse(detail);

  expect(result.data).toStrictEqual({
    trigger: 'RAM over budget',
    durationMs: 900,
    steps: { pause: 1, snapshot: 700 },
  });
});

test.each([
  'booted',
  'woke',
  'slept',
  'stopped',
  'failed',
  'repaired',
  'adopted',
  'held',
  'restored',
  'resized',
  'updated',
  'exposed',
  'released',
])('#ImpChangeReasonSchema accepts the reason %s', (reason) => {
  expect(ImpChangeReasonSchema.safeParse(reason).data).toBe(reason);
});

test('#ImpChangeReasonSchema rejects an unknown reason', () => {
  const result = ImpChangeReasonSchema.safeParse('moved');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});

test('#ImpEventSchema accepts an imp added as the stream opens', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp: {
      id: 'imp-1',
      name: 'dev',
      image: 'base',
      state: 'running',
      vcpus: 1,
      memoryMib: 512,
      diskMib: 1024,
      ip: '10.0.0.2',
      slot: 1,
      port: 7001,
      httpPort: 8080,
      url: 'http://dev.example.com',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      lastActiveAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema accepts an imp that changed, with its detail', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpChanged',
    reason: 'slept',
    imp: {
      id: 'imp-1',
      name: 'dev',
      image: 'base',
      state: 'running',
      vcpus: 1,
      memoryMib: 512,
      diskMib: 1024,
      ip: '10.0.0.2',
      slot: 1,
      port: 7001,
      httpPort: 8080,
      url: 'http://dev.example.com',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      lastActiveAt: new Date('2026-01-02T03:04:05.000Z'),
    },
    detail: { durationMs: 900, trigger: 'idle' },
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema accepts an imp removed', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpRemoved',
    imp: {
      id: 'imp-1',
      name: 'dev',
      image: 'base',
      state: 'running',
      vcpus: 1,
      memoryMib: 512,
      diskMib: 1024,
      ip: '10.0.0.2',
      slot: 1,
      port: 7001,
      httpPort: 8080,
      url: 'http://dev.example.com',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      lastActiveAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema accepts a checkpoint added', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'CheckpointAdded',
    name: 'dev',
    checkpoint: { id: 'ck-1', createdAt: new Date('2026-01-02T03:04:05.000Z'), diskMib: 1024 },
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema accepts a checkpoint removed', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'CheckpointRemoved',
    name: 'dev',
    checkpoint: { id: 'ck-1', createdAt: new Date('2026-01-02T03:04:05.000Z'), diskMib: 1024 },
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema accepts a refused boot with what it lacked', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'GovernorDecision',
    decision: 'refused',
    name: 'dev',
    trigger: 'wake',
    usedMib: 3072,
    budgetMib: 4096,
    reserveMib: 256,
    neededMib: 512,
    protectedCount: 2,
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema accepts an agent exec', () => {
  const payload = {
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'AgentExec',
    name: 'dev',
    actor: 'token',
    actorName: 'ci',
    tty: false,
    command: 'git',
  } as const;

  const result = ImpEventSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ImpEventSchema rejects an event of an unknown kind', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpMoved',
    name: 'dev',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['ev'], code: 'invalid_union' });
});

test('#ImpEventSchema rejects an event of another version', () => {
  const result = ImpEventSchema.safeParse({
    v: 2,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpAdded',
    reason: 'created',
    imp: {
      id: 'imp-1',
      name: 'dev',
      image: 'base',
      state: 'running',
      vcpus: 1,
      memoryMib: 512,
      diskMib: 1024,
      ip: '10.0.0.2',
      slot: 1,
      port: 7001,
      httpPort: 8080,
      url: 'http://dev.example.com',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      lastActiveAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['v'], code: 'invalid_value' });
});

test('#ImpEventSchema rejects an imp added for an unknown reason', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpAdded',
    reason: 'imported',
    imp: {
      id: 'imp-1',
      name: 'dev',
      image: 'base',
      state: 'running',
      vcpus: 1,
      memoryMib: 512,
      diskMib: 1024,
      ip: '10.0.0.2',
      slot: 1,
      port: 7001,
      httpPort: 8080,
      url: 'http://dev.example.com',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      lastActiveAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#ImpEventSchema rejects an imp that changed for an unknown reason', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'ImpChanged',
    reason: 'moved',
    imp: {
      id: 'imp-1',
      name: 'dev',
      image: 'base',
      state: 'running',
      vcpus: 1,
      memoryMib: 512,
      diskMib: 1024,
      ip: '10.0.0.2',
      slot: 1,
      port: 7001,
      httpPort: 8080,
      url: 'http://dev.example.com',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      lastActiveAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#ImpEventSchema rejects a governor decision of an unknown kind', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'GovernorDecision',
    decision: 'deferred',
    name: 'dev',
    trigger: 'wake',
    usedMib: 3072,
    budgetMib: 4096,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['decision'], code: 'invalid_value' });
});

test('#ImpEventSchema rejects a governor decision with negative used memory', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'GovernorDecision',
    decision: 'refused',
    name: 'dev',
    trigger: 'wake',
    usedMib: -1,
    budgetMib: 4096,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['usedMib'], code: 'too_small' });
});

test('#ImpEventSchema rejects a governor decision with no budget', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'GovernorDecision',
    decision: 'refused',
    name: 'dev',
    trigger: 'wake',
    usedMib: 3072,
    budgetMib: 0,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['budgetMib'], code: 'too_small' });
});

test('#ImpEventSchema rejects an agent exec by an unknown actor', () => {
  const result = ImpEventSchema.safeParse({
    v: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    ev: 'AgentExec',
    name: 'dev',
    actor: 'robot',
    actorName: 'ci',
    tty: false,
    command: 'git',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['actor'], code: 'invalid_value' });
});
