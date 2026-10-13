import { expect, test } from 'bun:test';
import {
  SessionLogDeleteInputSchema,
  SessionLogListInputSchema,
  SessionLogReadInputSchema,
  SessionLogReadSchema,
  SessionLogSchema,
} from './session-log-schema';

test('#SessionLogSchema accepts a complete log that ended with an exit', () => {
  const payload = {
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'ended',
    logStart: 0,
    logEnd: 4096,
    bytes: 4096,
    end: 4096,
    exitCode: 0,
    complete: true,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    endedAt: new Date('2026-01-02T04:00:00.000Z'),
  } as const;

  const result = SessionLogSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionLogSchema accepts a live log that stopped at the disk reserve', () => {
  const payload = {
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'live',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    complete: false,
    stopped: 'disk_full',
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  const result = SessionLogSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionLogSchema rejects a session name that is not a session name', () => {
  const result = SessionLogSchema.safeParse({
    session: 'Main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'live',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['session'], code: 'invalid_format' });
});

test('#SessionLogSchema rejects a generation that is not 32 hex digits', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: 'gen-1',
    bootId: 'boot-1',
    state: 'live',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#SessionLogSchema rejects a state outside the list', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'paused',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['state'], code: 'invalid_value' });
});

test('#SessionLogSchema rejects a negative log start', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'live',
    logStart: -1,
    logEnd: 8192,
    bytes: 7168,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['logStart'], code: 'too_small' });
});

test('#SessionLogSchema rejects a negative log end', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'live',
    logStart: 1024,
    logEnd: -1,
    bytes: 7168,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['logEnd'], code: 'too_small' });
});

test('#SessionLogSchema rejects a fractional byte count', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'live',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168.5,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'invalid_type' });
});

test('#SessionLogSchema rejects a negative end', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'ended',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    end: -1,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['end'], code: 'too_small' });
});

test('#SessionLogSchema rejects a fractional exit code', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'ended',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    exitCode: 0.5,
    complete: false,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['exitCode'], code: 'invalid_type' });
});

test('#SessionLogSchema rejects a stop reason outside the list', () => {
  const result = SessionLogSchema.safeParse({
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    state: 'live',
    logStart: 1024,
    logEnd: 8192,
    bytes: 7168,
    complete: false,
    stopped: 'quota',
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['stopped'], code: 'invalid_value' });
});

test('#SessionLogListInputSchema accepts an imp and a session', () => {
  const payload = { name: 'dev', session: 'main' } as const;

  expect(SessionLogListInputSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#SessionLogListInputSchema accepts an imp alone, for the logs of every session', () => {
  const payload = { name: 'dev' } as const;

  expect(SessionLogListInputSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#SessionLogListInputSchema rejects an imp name that is not a name', () => {
  const result = SessionLogListInputSchema.safeParse({ name: 'Dev', session: 'main' });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#SessionLogListInputSchema rejects a session name that is not a session name', () => {
  const result = SessionLogListInputSchema.safeParse({ name: 'dev', session: 'Main' });

  expect(result.error?.issues).toPartiallyContain({ path: ['session'], code: 'invalid_format' });
});

test('#SessionLogReadInputSchema accepts a read of the largest size', () => {
  const payload = {
    name: 'dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: 0,
    limit: 1_048_576,
  } as const;

  const result = SessionLogReadInputSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionLogReadInputSchema accepts a read without a limit', () => {
  const payload = {
    name: 'dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: 0,
  } as const;

  expect(SessionLogReadInputSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#SessionLogReadInputSchema rejects an imp name that is not a name', () => {
  const result = SessionLogReadInputSchema.safeParse({
    name: 'Dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: 0,
    limit: 1024,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#SessionLogReadInputSchema rejects a session name that is not a session name', () => {
  const result = SessionLogReadInputSchema.safeParse({
    name: 'dev',
    session: 'Main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: 0,
    limit: 1024,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['session'], code: 'invalid_format' });
});

test('#SessionLogReadInputSchema rejects a generation that is not 32 hex digits', () => {
  const result = SessionLogReadInputSchema.safeParse({
    name: 'dev',
    session: 'main',
    executionGeneration: 'gen-1',
    from: 0,
    limit: 1024,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#SessionLogReadInputSchema rejects a negative start', () => {
  const result = SessionLogReadInputSchema.safeParse({
    name: 'dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: -1,
    limit: 1024,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['from'], code: 'too_small' });
});

test('#SessionLogReadInputSchema rejects a limit of zero', () => {
  const result = SessionLogReadInputSchema.safeParse({
    name: 'dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: 0,
    limit: 0,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['limit'], code: 'too_small' });
});

test('#SessionLogReadInputSchema rejects a limit over one MiB', () => {
  const result = SessionLogReadInputSchema.safeParse({
    name: 'dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    from: 0,
    limit: 1_048_577,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['limit'], code: 'too_big' });
});

test('#SessionLogReadSchema accepts a read with a gap', () => {
  const payload = {
    offset: 2048,
    gap: { from: 1024, to: 2048 },
    data: new Blob(['hello']),
    log: {
      session: 'main',
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: 'boot-1',
      state: 'live',
      logStart: 2048,
      logEnd: 2053,
      bytes: 5,
      complete: false,
      startedAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  } as const;

  const result = SessionLogReadSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionLogReadSchema accepts a read without a gap', () => {
  const payload = {
    offset: 0,
    data: new Blob(['hello']),
    log: {
      session: 'main',
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: 'boot-1',
      state: 'live',
      logStart: 0,
      logEnd: 5,
      bytes: 5,
      complete: false,
      startedAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  } as const;

  expect(SessionLogReadSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#SessionLogReadSchema rejects data that is not a blob', () => {
  const result = SessionLogReadSchema.safeParse({
    offset: 2048,
    gap: { from: 1024, to: 2048 },
    data: 'hello',
    log: {
      session: 'main',
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: 'boot-1',
      state: 'live',
      logStart: 2048,
      logEnd: 2053,
      bytes: 5,
      complete: false,
      startedAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['data'], code: 'invalid_type' });
});

test('#SessionLogReadSchema rejects a negative offset', () => {
  const result = SessionLogReadSchema.safeParse({
    offset: -1,
    gap: { from: 1024, to: 2048 },
    data: new Blob(['hello']),
    log: {
      session: 'main',
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: 'boot-1',
      state: 'live',
      logStart: 2048,
      logEnd: 2053,
      bytes: 5,
      complete: false,
      startedAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['offset'], code: 'too_small' });
});

test('#SessionLogReadSchema rejects a gap with a negative start', () => {
  const result = SessionLogReadSchema.safeParse({
    offset: 2048,
    gap: { from: -1, to: 2048 },
    data: new Blob(['hello']),
    log: {
      session: 'main',
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: 'boot-1',
      state: 'live',
      logStart: 2048,
      logEnd: 2053,
      bytes: 5,
      complete: false,
      startedAt: new Date('2026-01-02T03:04:05.000Z'),
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['gap', 'from'], code: 'too_small' });
});

test('#SessionLogDeleteInputSchema accepts a generation named with its session', () => {
  const payload = {
    name: 'dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
  } as const;

  const result = SessionLogDeleteInputSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionLogDeleteInputSchema accepts an imp alone', () => {
  expect(SessionLogDeleteInputSchema.safeParse({ name: 'dev' }).data).toStrictEqual({
    name: 'dev',
  });
});

test('#SessionLogDeleteInputSchema rejects a generation without its session', () => {
  const result = SessionLogDeleteInputSchema.safeParse({
    name: 'dev',
    executionGeneration: '0123456789abcdef0123456789abcdef',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    message: 'a generation is named with its session',
  });
});

test('#SessionLogDeleteInputSchema rejects an imp name that is not a name', () => {
  const result = SessionLogDeleteInputSchema.safeParse({
    name: 'Dev',
    session: 'main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#SessionLogDeleteInputSchema rejects a session name that is not a session name', () => {
  const result = SessionLogDeleteInputSchema.safeParse({
    name: 'dev',
    session: 'Main',
    executionGeneration: '0123456789abcdef0123456789abcdef',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['session'], code: 'invalid_format' });
});

test('#SessionLogDeleteInputSchema rejects a generation that is not 32 hex digits', () => {
  const result = SessionLogDeleteInputSchema.safeParse({
    name: 'dev',
    session: 'main',
    executionGeneration: 'gen-1',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});
