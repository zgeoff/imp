import { expect, test } from 'bun:test';
import { ApiActorSchema, ApiCallSchema } from './api-call-schema';

test.each(['token', 'dashboard', 'ssh', 'tailnet', 'oauth'])(
  '#ApiActorSchema accepts the %s actor',
  (input) => {
    expect(ApiActorSchema.safeParse(input).data).toBe(input);
  },
);

test.each(['cookie', ''])('#ApiActorSchema rejects the unknown actor %s', (input) => {
  const result = ApiActorSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#ApiCallSchema accepts a row without its optional fields', () => {
  const payload = {
    at: new Date('2026-01-02T03:04:05.000Z'),
    procedure: 'imps.create',
    actor: 'token',
    outcome: 'ok',
    durationMs: 12,
  } as const;

  expect(ApiCallSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ApiCallSchema accepts a row with every optional field', () => {
  const payload = {
    at: new Date('2026-01-02T03:04:05.000Z'),
    procedure: 'imps.create',
    actor: 'token',
    outcome: 'ok',
    durationMs: 12,
    actorName: 'laptop',
    imp: 'dev',
    detail: 'docker.io/library/alpine@sha256:abc',
  } as const;

  expect(ApiCallSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ApiCallSchema rejects an actor outside the actor list', () => {
  const result = ApiCallSchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    procedure: 'imps.create',
    actor: 'cookie',
    outcome: 'ok',
    durationMs: 12,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['actor'] }));
});

test('#ApiCallSchema rejects an imp that is not a valid name', () => {
  const result = ApiCallSchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    procedure: 'imps.create',
    actor: 'token',
    outcome: 'ok',
    durationMs: 12,
    imp: 'Dev',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['imp'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#ApiCallSchema rejects a negative duration', () => {
  const result = ApiCallSchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    procedure: 'imps.create',
    actor: 'token',
    outcome: 'ok',
    durationMs: -1,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['durationMs'] }),
  );
});

test('#ApiCallSchema rejects a fractional duration', () => {
  const result = ApiCallSchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    procedure: 'imps.create',
    actor: 'token',
    outcome: 'ok',
    durationMs: 1.5,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['durationMs'] }),
  );
});
