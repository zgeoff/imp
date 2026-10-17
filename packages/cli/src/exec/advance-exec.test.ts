import { expect, test } from 'bun:test';
import { advanceExec } from './advance-exec';
import type { ExecMachine } from './advance-exec';

test('#advanceExec marks a session started and says whether it was away', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: 'main',
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: true,
    reattachUntil: 61_000,
    tries: 2,
  };

  expect(advanceExec(machine, { kind: 'started' })).toStrictEqual({
    machine: { ...machine, reattachUntil: null, tries: 0 },
    step: { kind: 'attached', wasAway: true },
  });
});

test('#advanceExec ends a plain exec with the code its command exited with', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: null,
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: true,
    reattachUntil: null,
    tries: 0,
  };

  const transition = advanceExec(machine, {
    kind: 'outcome',
    outcome: { kind: 'exit', code: 3, signal: null },
    now: 0,
  });

  expect(transition.step).toStrictEqual({ kind: 'stop', code: 3, message: null });
});

test('#advanceExec attaches again to a lost session, doubling each pause up to its cap', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: 'main',
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: true,
    reattachUntil: 50_000,
    tries: 4,
  };

  expect(
    advanceExec(machine, {
      kind: 'outcome',
      outcome: { kind: 'detached', reason: 'lost' },
      now: 20_000,
    }),
  ).toStrictEqual({
    machine: { ...machine, tries: 5 },
    step: { kind: 'reattach', delayMs: 8000, isFirst: false },
  });
});

test('#advanceExec opens the reattach window on the first loss', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: 'main',
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: true,
    reattachUntil: null,
    tries: 0,
  };

  expect(
    advanceExec(machine, {
      kind: 'outcome',
      outcome: { kind: 'closed', reason: 'impd restarted' },
      now: 5000,
    }),
  ).toStrictEqual({
    machine: { ...machine, reattachUntil: 65_000, tries: 1 },
    step: { kind: 'reattach', delayMs: 1000, isFirst: true },
  });
});

test('#advanceExec gives up on a lost session once the window is over', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: 'main',
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: true,
    reattachUntil: 65_000,
    tries: 9,
  };

  const transition = advanceExec(machine, {
    kind: 'outcome',
    outcome: { kind: 'closed', reason: 'impd restarted' },
    now: 65_000,
  });

  expect(transition.step).toStrictEqual({
    kind: 'stop',
    code: 255,
    message: 'exec connection closed (impd restarted)',
  });
});

test('#advanceExec never attaches again to a session that never started', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: 'main',
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: false,
    reattachUntil: null,
    tries: 0,
  };

  const transition = advanceExec(machine, {
    kind: 'outcome',
    outcome: { kind: 'unreachable', detail: 'connection refused' },
    now: 0,
  });

  expect(transition.step).toStrictEqual({
    kind: 'stop',
    code: 255,
    message: 'cannot reach impd at http://impd.test (connection refused)',
  });
});

test('#advanceExec ends with 254 when another client holds the session', () => {
  const machine: ExecMachine = {
    imp: 'box',
    session: 'main',
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: true,
    reattachUntil: 65_000,
    tries: 1,
  };

  expect(advanceExec(machine, { kind: 'taken_over' }).step).toStrictEqual({
    kind: 'stop',
    code: 254,
    message: 'another client attached to session main (impz attach box main)',
  });
});

test.each([
  ['PRECONDITION_FAILED', 1],
  ['EXEC_FAILED', 127],
  ['INNER_DOWN', 255],
])('#advanceExec ends a refused exec with %s with code %d', (code, expected) => {
  const machine: ExecMachine = {
    imp: 'box',
    session: null,
    config: { url: 'http://impd.test', token: null, host: null },
    windowMs: 60_000,
    firstDelayMs: 1000,
    started: false,
    reattachUntil: null,
    tries: 0,
  };

  const transition = advanceExec(machine, {
    kind: 'outcome',
    outcome: { kind: 'failed', code, message: 'refused' },
    now: 0,
  });

  expect(transition.step).toMatchObject({ kind: 'stop', code: expected });
});
