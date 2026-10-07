import { expect, test } from 'bun:test';
import { SessionExitSchema, SessionNameSchema, SessionSchema } from './session-schema';

test.each(['main', '0shell', 'build-2', `a${'b'.repeat(31)}`])(
  '#SessionNameSchema accepts the name %s',
  (name) => {
    expect(SessionNameSchema.safeParse(name).data).toBe(name);
  },
);

test.each(['', '-main', 'Main', 'my_session', 'main.1', `a${'b'.repeat(32)}`])(
  '#SessionNameSchema rejects the name %p',
  (name) => {
    const result = SessionNameSchema.safeParse(name);

    expect(result.error?.issues).toPartiallyContain({
      path: [],
      message:
        'must be a lowercase letter or digit followed by up to 31 lowercase letters, digits or hyphens',
    });
  },
);

test('#SessionExitSchema accepts an exit by signal', () => {
  const payload = { code: null, signal: 'SIGTERM' } as const;

  expect(SessionExitSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#SessionExitSchema rejects a fractional exit code', () => {
  const result = SessionExitSchema.safeParse({ code: 1.5, signal: null });

  expect(result.error?.issues).toPartiallyContain({ path: ['code'], code: 'invalid_type' });
});

test('#SessionSchema accepts a session with offsets and a log', () => {
  const payload = {
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'exited',
    attached: false,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    exit: { code: 0, signal: null },
    continuity: 'offsets',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bootId: 'boot-1',
    end: 4096,
    endObservedAt: new Date('2026-01-02T03:05:00.000Z'),
    log: true,
  } as const;

  const result = SessionSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionSchema accepts a running session from an older impd', () => {
  const payload = {
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  const result = SessionSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionSchema rejects a name that is not a session name', () => {
  const result = SessionSchema.safeParse({
    name: 'Main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#SessionSchema rejects a pid of zero', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 0,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['pid'], code: 'too_small' });
});

test('#SessionSchema rejects a state outside the list', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'sleeping',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['state'], code: 'invalid_value' });
});

test('#SessionSchema rejects zero columns', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 0,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['cols'], code: 'too_small' });
});

test('#SessionSchema rejects zero rows', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 0,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['rows'], code: 'too_small' });
});

test('#SessionSchema rejects a start time that is not a date', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: '2026-01-02T03:04:05.000Z',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['startedAt'], code: 'invalid_type' });
});

test('#SessionSchema rejects a continuity outside the list', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    continuity: 'lines',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['continuity'], code: 'invalid_value' });
});

test('#SessionSchema rejects a generation that is not 32 hex digits', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    executionGeneration: 'gen-1',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#SessionSchema rejects a negative end', () => {
  const result = SessionSchema.safeParse({
    name: 'main',
    pid: 42,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 80,
    rows: 24,
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    end: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['end'], code: 'too_small' });
});
