import { expect, test } from 'bun:test';
import { SessionSchema } from '../session-schema';
import { buildMockSession } from './build-mock-session';

test('it builds a default session', () => {
  const session = buildMockSession();
  const parsed: unknown = SessionSchema.safeParse(session).data;
  const received: unknown = session;

  expect(received).toStrictEqual({
    name: expect.stringMatching(/^[a-z0-9][a-z0-9-]{2,12}$/) as unknown,
    pid: expect.any(Number) as unknown,
    argv: [expect.any(String)] as unknown,
    state: 'running',
    attached: false,
    cols: expect.any(Number) as unknown,
    rows: expect.any(Number) as unknown,
    startedAt: expect.toBeValidDate() as unknown,
    continuity: 'offsets',
    executionGeneration: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
    bootId: expect.any(String) as unknown,
    end: expect.any(Number) as unknown,
    endObservedAt: expect.toBeValidDate() as unknown,
    log: false,
  });

  expect(parsed).toStrictEqual(session);
  expect(session.endObservedAt).not.toBeBefore(session.startedAt);
});

test('it applies overrides on top of the defaults', () => {
  const session: unknown = buildMockSession({
    name: 'job',
    state: 'exited',
    exit: { code: 3, signal: null },
  });

  expect(session).toStrictEqual({
    name: 'job',
    pid: expect.any(Number) as unknown,
    argv: [expect.any(String)] as unknown,
    state: 'exited',
    attached: false,
    cols: expect.any(Number) as unknown,
    rows: expect.any(Number) as unknown,
    startedAt: expect.toBeValidDate() as unknown,
    continuity: 'offsets',
    executionGeneration: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
    bootId: expect.any(String) as unknown,
    end: expect.any(Number) as unknown,
    endObservedAt: expect.toBeValidDate() as unknown,
    log: false,
    exit: { code: 3, signal: null },
  });
});
