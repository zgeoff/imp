import { expect, test } from 'bun:test';
import {
  EXEC_CHANNELS,
  ExecClientMessageSchema,
  ExecServerMessageSchema,
  ExecStartMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from './exec-protocol';
import type { ExecClientMessage } from './exec-protocol';

test('it round-trips a binary frame through encode and decode', () => {
  const data = new TextEncoder().encode('hello\n');

  const frame = encodeExecFrame(EXEC_CHANNELS.stdout, data);

  expect(frame[0]).toBe(EXEC_CHANNELS.stdout);
  expect(frame.byteLength).toBe(data.byteLength + 1);

  const decoded = decodeExecFrame(frame);

  expect(decoded.channel).toBe(EXEC_CHANNELS.stdout);
  expect(decoded.data).toEqual(data);
});

test('it decodes a frame with an empty payload', () => {
  const decoded = decodeExecFrame(encodeExecFrame(EXEC_CHANNELS.stderr, new Uint8Array()));

  expect(decoded.channel).toBe(EXEC_CHANNELS.stderr);
  expect(decoded.data.byteLength).toBe(0);
});

test('it rejects an empty frame and an unknown channel byte', () => {
  expect(() => decodeExecFrame(new Uint8Array())).toThrow('unknown channel');
  expect(() => decodeExecFrame(Uint8Array.of(9, 1, 2))).toThrow('unknown channel');
});

test('it parses each client control message', () => {
  const messages: readonly ExecClientMessage[] = [
    { type: 'start', name: 'dev', argv: ['bash', '-l'], tty: true, cols: 80, rows: 24 },
    { type: 'stdin_eof' },
    { type: 'resize', cols: 120, rows: 40 },
    { type: 'signal', signal: 'SIGINT' },
    { type: 'start', name: 'dev', argv: ['bash'], tty: true, session: 'main' },
    { type: 'attach', name: 'dev', session: 'main', cols: 80, rows: 24 },
  ];

  for (const message of messages) {
    expect(ExecClientMessageSchema.parse(message)).toEqual(message);
  }
});

test('it rejects a start message with an empty argv', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: [],
    tty: false,
  });

  expect(result.success).toBe(false);
});

test('it parses an exit message ended by a signal', () => {
  const message = { type: 'exit', code: null, signal: 'SIGKILL' } as const;

  expect(ExecServerMessageSchema.parse(message)).toEqual(message);
});

test('it rejects a session without a tty and a bad session name', () => {
  const noTty = ExecClientMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: false,
    session: 'main',
  });

  const badName = ExecClientMessageSchema.safeParse({
    type: 'attach',
    name: 'dev',
    session: '-Main',
  });

  expect(noTty.success).toBe(false);
  expect(badName.success).toBe(false);
});

test('it parses the session server messages', () => {
  const messages = [
    { type: 'started', pid: 7, session: 'main', created: true },
    { type: 'detached', reason: 'taken_over' },
  ] as const;

  for (const message of messages) {
    expect(ExecServerMessageSchema.parse(message)).toEqual(message);
  }

  expect(ExecServerMessageSchema.safeParse({ type: 'detached', reason: 'bored' }).success).toBe(
    false,
  );
});

test('an outer exec takes no tool or session', () => {
  const start = { type: 'start', name: 'dev', argv: ['sh'], tty: true, outer: true } as const;

  expect(ExecStartMessageSchema.safeParse(start).success).toBe(true);
  expect(ExecStartMessageSchema.safeParse({ ...start, session: 'main' }).success).toBe(false);

  expect(ExecStartMessageSchema.safeParse({ ...start, tty: false, tool: 'tar' }).success).toBe(
    false,
  );
});

test('a start requires only known things, and not for a tool or an outer exec', () => {
  const start = { type: 'start', name: 'dev', argv: ['sh'], tty: false } as const;

  expect(ExecStartMessageSchema.safeParse({ ...start, require: ['broker'] }).success).toBe(true);
  expect(ExecStartMessageSchema.safeParse({ ...start, require: [] }).success).toBe(true);
  expect(ExecStartMessageSchema.safeParse({ ...start, require: ['network'] }).success).toBe(false);

  expect(
    ExecStartMessageSchema.safeParse({ ...start, tool: 'tar', require: ['broker'] }).success,
  ).toBe(false);

  expect(
    ExecStartMessageSchema.safeParse({ ...start, outer: true, require: ['broker'] }).success,
  ).toBe(false);
});
