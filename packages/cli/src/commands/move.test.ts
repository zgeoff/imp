import { expect, test } from 'bun:test';
import type { MoveStatus } from '@imp/api';
import type { ImpClient } from '../create-imp-client';
import { runMove } from './move';
import type { MoveRun } from './move';

type Moves = ImpClient['moves'];

// what the promise rejected with, or null when it resolved
async function readRejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }

  return null;
}

const IDLE: MoveStatus = {
  state: null,
  peer: null,
  sentBytes: 0,
  totalBytes: 0,
  isDone: false,
  error: null,
};

// one host's moves namespace: each call logged, each answer from `answers`
function createFakeMoves(
  writeCall: (call: string) => void,
  host: string,
  answers: Partial<Record<keyof Moves, unknown>>,
) {
  const buildAnswer = (method: keyof Moves) => (input: unknown) => {
    writeCall(`${host} ${method} ${JSON.stringify(input)}`);

    const value = answers[method];

    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fake of the client's moves namespace; each test sets only the answers it uses
  return {
    moves: {
      prepare: buildAnswer('prepare'),
      facts: buildAnswer('facts'),
      receive: buildAnswer('receive'),
      send: buildAnswer('send'),
      status: buildAnswer('status'),
      reissue: buildAnswer('reissue'),
      resume: buildAnswer('resume'),
      abort: buildAnswer('abort'),
    },
    system: { info: () => Promise.resolve({ storage: { backend: 'xfs' } }) },
  } as unknown as Pick<ImpClient, 'moves' | 'system'>;
}

function setupRun(
  mode: MoveRun['mode'],
  from: Partial<Record<keyof Moves, unknown>>,
  to: Partial<Record<keyof Moves, unknown>> = {},
) {
  const calls: string[] = [];
  const printed: string[] = [];

  const writeCall = (call: string) => {
    calls.push(call);
  };

  const run: MoveRun = {
    name: 'dev',
    from: createFakeMoves(writeCall, 'a', from),
    to: createFakeMoves(writeCall, 'b', to),
    toHost: 'b',
    mode,
    stop: false,
    output: { isTTY: false, write: () => {} },
    print: (line) => {
      printed.push(line);
    },
    wait: () => Promise.resolve(),
  };

  return { run, calls, printed };
}

test('a move prepares on the source, takes a ticket from the target, then sends', async () => {
  const ctx = setupRun(
    'move',
    {
      prepare: { bytes: 10, checkpoints: 0, warm: null },
      send: IDLE,
      status: { ...IDLE, isDone: true },
    },
    { receive: { ticket: 't.s', expiresAt: new Date(0), peerUrl: 'http://100.64.0.2:7070' } },
  );

  await runMove(ctx.run);

  expect(ctx.calls).toEqual([
    'b facts undefined',
    'a prepare {"name":"dev","stop":false,"targetStorage":"xfs"}',
    'b receive {"name":"dev","bytes":10}',
    'a send {"name":"dev","to":"http://100.64.0.2:7070","ticket":"t.s"}',
    'a status {"name":"dev"}',
  ]);

  expect(ctx.printed).toEqual(['dev: moved to b']);
});

test('a sleeping imp moves warm: the target facts go to prepare, the plan to receive', async () => {
  const facts = { cpuModel: 'Test CPU' };
  const warm = { slot: 3 };

  const ctx = setupRun(
    'move',
    {
      prepare: { bytes: 10, checkpoints: 0, warm },
      send: IDLE,
      status: { ...IDLE, isDone: true },
    },
    {
      facts,
      receive: { ticket: 't.s', expiresAt: new Date(0), peerUrl: 'http://100.64.0.2:7070' },
    },
  );

  await runMove(ctx.run);

  expect(ctx.calls.slice(0, 3)).toEqual([
    'b facts undefined',
    'a prepare {"name":"dev","stop":false,"targetStorage":"xfs","target":{"cpuModel":"Test CPU"}}',
    'b receive {"name":"dev","bytes":10,"warm":{"slot":3}}',
  ]);

  expect(ctx.printed).toEqual(['dev: moved to b, asleep with its memory']);
});

test('a target that refuses the ticket gets the source mark taken off', async () => {
  const ctx = setupRun(
    'move',
    { prepare: { bytes: 10, checkpoints: 0, warm: null }, abort: IDLE },
    { receive: new Error('this host has an imp named dev') },
  );

  const error = await readRejection(runMove(ctx.run));

  expect(String(error)).toContain('this host has an imp named dev');
  expect(ctx.calls.at(-1)).toBe('a abort {"name":"dev"}');
});

test('a failed send after the receipt points at --resume', async () => {
  const ctx = setupRun(
    'move',
    {
      prepare: { bytes: 10, checkpoints: 0, warm: null },
      send: IDLE,
      status: { ...IDLE, state: 'moved', error: 'commit: the target answered 500' },
    },
    { receive: { ticket: 't.s', expiresAt: new Date(0), peerUrl: 'http://100.64.0.2:7070' } },
  );

  const error = await readRejection(runMove(ctx.run));

  expect(String(error)).toContain('imp move dev b --resume, or --abort');
});

test('a failed send the target did not undo points at --abort, not at nothing changed', async () => {
  const ctx = setupRun(
    'move',
    {
      prepare: { bytes: 10, checkpoints: 0 },
      send: IDLE,
      status: { ...IDLE, state: 'sending', error: 'Unable to connect' },
    },
    { receive: { ticket: 't.s', expiresAt: new Date(0), peerUrl: 'http://100.64.0.2:7070' } },
  );

  const rejection = await readRejection(runMove(ctx.run));

  const error = String(rejection);

  expect(error).toContain('the imp stays marked here: run imp move dev b --abort once b answers');
  expect(error).not.toContain('nothing changed');
});

test('resume commits with a fresh ticket from the target', async () => {
  const ctx = setupRun(
    'resume',
    { status: { ...IDLE, state: 'moved' }, resume: { ...IDLE, isDone: true } },
    { reissue: { ticket: 'n.s', expiresAt: new Date(0), peerUrl: 'http://100.64.0.2:7070' } },
  );

  await runMove(ctx.run);

  expect(ctx.calls.slice(1)).toEqual([
    'b reissue {"name":"dev"}',
    'a resume {"name":"dev","ticket":"n.s"}',
  ]);
});

test('an abort the target answers with its commit says the move is complete', async () => {
  const ctx = setupRun('abort', { abort: { ...IDLE, isDone: true } });

  await runMove(ctx.run);

  expect(ctx.printed).toEqual(['dev: b had committed it already; the move is complete']);
});
