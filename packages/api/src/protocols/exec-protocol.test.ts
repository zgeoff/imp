import { expect, test } from 'bun:test';
import {
  EXEC_CHANNELS,
  ExecAttachMessageSchema,
  ExecClientMessageSchema,
  ExecServerMessageSchema,
  ExecStartMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from './exec-protocol';

test('#encodeExecFrame prefixes the channel byte to the payload when it encodes a frame', () => {
  expect(encodeExecFrame(EXEC_CHANNELS.stdout, Uint8Array.of(104, 105))).toStrictEqual(
    Uint8Array.of(1, 104, 105),
  );
});

test('#decodeExecFrame decodes an encoded frame back to its channel and payload', () => {
  const frame = encodeExecFrame(EXEC_CHANNELS.stdout, Uint8Array.of(104, 105, 10));
  const decoded = decodeExecFrame(frame);

  expect(decoded).toStrictEqual({
    channel: EXEC_CHANNELS.stdout,
    data: Uint8Array.of(104, 105, 10),
  });
});

test('#decodeExecFrame decodes a frame with an empty payload', () => {
  const decoded = decodeExecFrame(Uint8Array.of(EXEC_CHANNELS.stderr));

  expect(decoded.channel).toBe(EXEC_CHANNELS.stderr);
  expect(decoded.data).toBeEmpty();
});

test('#decodeExecFrame rejects an empty frame', () => {
  expect(() => decodeExecFrame(new Uint8Array())).toThrowWithMessage(
    Error,
    'exec frame has an unknown channel byte: undefined',
  );
});

test('#decodeExecFrame rejects a frame with an unknown channel byte', () => {
  expect(() => decodeExecFrame(Uint8Array.of(9, 1, 2))).toThrowWithMessage(
    Error,
    'exec frame has an unknown channel byte: 9',
  );
});

test('#ExecClientMessageSchema accepts a tty start message', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash', '-l'],
    tty: true,
    cols: 80,
    rows: 24,
  });

  expect(result.data).toStrictEqual({
    type: 'start',
    name: 'dev',
    argv: ['bash', '-l'],
    tty: true,
    cols: 80,
    rows: 24,
  });
});

test('#ExecClientMessageSchema accepts a start message for a session', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: true,
    session: 'main',
  });

  expect(result.data).toStrictEqual({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: true,
    session: 'main',
  });
});

test('#ExecClientMessageSchema accepts an attach message', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'attach',
    name: 'dev',
    session: 'main',
    cols: 80,
    rows: 24,
  });

  expect(result.data).toStrictEqual({
    type: 'attach',
    name: 'dev',
    session: 'main',
    cols: 80,
    rows: 24,
  });
});

test('#ExecClientMessageSchema accepts a stdin_eof message', () => {
  expect(ExecClientMessageSchema.safeParse({ type: 'stdin_eof' }).data).toStrictEqual({
    type: 'stdin_eof',
  });
});

test('#ExecClientMessageSchema accepts a resize message', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'resize', cols: 120, rows: 40 });

  expect(result.data).toStrictEqual({ type: 'resize', cols: 120, rows: 40 });
});

test('#ExecClientMessageSchema accepts a signal message', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'signal', signal: 'SIGINT' });

  expect(result.data).toStrictEqual({ type: 'signal', signal: 'SIGINT' });
});

test('#ExecClientMessageSchema accepts a stdout_ack message', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'stdout_ack', bytes: 4096 });

  expect(result.data).toStrictEqual({ type: 'stdout_ack', bytes: 4096 });
});

test('#ExecClientMessageSchema rejects a start message with an empty argv', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: [],
    tty: false,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['argv'], code: 'too_small' });
});

test('#ExecClientMessageSchema rejects a resize message with a zero dimension', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'resize', cols: 0, rows: 40 });

  expect(result.error?.issues).toPartiallyContain({ path: ['cols'], code: 'too_small' });
});

test('#ExecClientMessageSchema rejects a resize message with a dimension past 65535', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'resize', cols: 120, rows: 65_536 });

  expect(result.error?.issues).toPartiallyContain({ path: ['rows'], code: 'too_big' });
});

test('#ExecClientMessageSchema rejects a signal message with a name that is not a signal', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'signal', signal: 'kill' });

  expect(result.error?.issues).toPartiallyContain({ path: ['signal'], code: 'invalid_format' });
});

test('#ExecClientMessageSchema rejects a stdout_ack of zero bytes', () => {
  const result = ExecClientMessageSchema.safeParse({ type: 'stdout_ack', bytes: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'too_small' });
});

test('#ExecClientMessageSchema rejects a session start without a tty', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: false,
    session: 'main',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['tty'],
    message: 'a session needs a tty',
  });
});

test('#ExecClientMessageSchema rejects an attach message with a bad session name', () => {
  const result = ExecClientMessageSchema.safeParse({
    type: 'attach',
    name: 'dev',
    session: '-Main',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['session'], code: 'invalid_format' });
});

test('#ExecStartMessageSchema rejects a resume without a session', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: true,
    resumeFrom: { executionGeneration: '0123456789abcdef0123456789abcdef', offset: 0 },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['resumeFrom'],
    message: 'only a session resumes',
  });
});

test('#ExecStartMessageSchema rejects a log without a session', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: true,
    log: true,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['log'],
    message: 'only a session keeps a log',
  });
});

test('#ExecStartMessageSchema rejects a kill grace on a tty exec', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['bash'],
    tty: true,
    killGraceMs: 1000,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['killGraceMs'],
    message: 'a tty exec takes no kill grace',
  });
});

test('#ExecStartMessageSchema rejects a tool with a tty', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['x'],
    tty: true,
    tool: 'tar',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['tool'],
    message: 'a tool takes no tty, session, env or cwd',
  });
});

test('#ExecStartMessageSchema accepts an outer exec', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    outer: true,
  });

  expect(result.data).toStrictEqual({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    outer: true,
  });
});

test('#ExecStartMessageSchema rejects an outer exec with a session', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    outer: true,
    session: 'main',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['outer'],
    message: 'an outer exec takes no tool or session',
  });
});

test('#ExecStartMessageSchema rejects an outer exec with a tool', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    outer: true,
    tool: 'tar',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['outer'],
    message: 'an outer exec takes no tool or session',
  });
});

test('#ExecStartMessageSchema accepts a start that requires the broker', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: ['broker'],
  });

  expect(result.data).toStrictEqual({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: ['broker'],
  });
});

test('#ExecStartMessageSchema accepts an empty require on a plain start', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: [],
  });

  expect(result.data).toStrictEqual({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: [],
  });
});

test('#ExecStartMessageSchema accepts an empty require on a tool', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    tool: 'tar',
    require: [],
  });

  expect(result.data).toStrictEqual({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    tool: 'tar',
    require: [],
  });
});

test('#ExecStartMessageSchema rejects an unknown requirement', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: ['network'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['require', 0], code: 'invalid_value' });
});

test('#ExecStartMessageSchema rejects a requirement on a tool', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: ['broker'],
    tool: 'tar',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['require'],
    message: 'a tool or an outer exec takes no require',
  });
});

test('#ExecStartMessageSchema rejects a requirement on an outer exec', () => {
  const result = ExecStartMessageSchema.safeParse({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: false,
    require: ['broker'],
    outer: true,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['require'],
    message: 'a tool or an outer exec takes no require',
  });
});

test('#ExecServerMessageSchema accepts a started message for a new session', () => {
  const result = ExecServerMessageSchema.safeParse({
    type: 'started',
    pid: 7,
    session: 'main',
    created: true,
  });

  expect(result.data).toStrictEqual({ type: 'started', pid: 7, session: 'main', created: true });
});

test('#ExecServerMessageSchema accepts a started message with session output', () => {
  const result = ExecServerMessageSchema.safeParse({
    type: 'started',
    pid: 7,
    groupKill: true,
    output: { continuity: 'none' },
  });

  expect(result.data).toStrictEqual({
    type: 'started',
    pid: 7,
    groupKill: true,
    output: { continuity: 'none' },
  });
});

test('#ExecServerMessageSchema rejects a started message with a zero pid', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'started', pid: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['pid'], code: 'too_small' });
});

test('#ExecServerMessageSchema accepts an exit message ended by a signal', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'exit', code: null, signal: 'SIGKILL' });

  expect(result.data).toStrictEqual({ type: 'exit', code: null, signal: 'SIGKILL' });
});

test('#ExecServerMessageSchema accepts an exit message with a code and an offset', () => {
  const result = ExecServerMessageSchema.safeParse({
    type: 'exit',
    code: 0,
    signal: null,
    offset: 512,
  });

  expect(result.data).toStrictEqual({ type: 'exit', code: 0, signal: null, offset: 512 });
});

test('#ExecServerMessageSchema accepts a detached message', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'detached', reason: 'taken_over' });

  expect(result.data).toStrictEqual({ type: 'detached', reason: 'taken_over' });
});

test('#ExecServerMessageSchema rejects a detached message with an unknown reason', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'detached', reason: 'bored' });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#ExecServerMessageSchema accepts a stdin_ack message', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'stdin_ack', bytes: 65_536 });

  expect(result.data).toStrictEqual({ type: 'stdin_ack', bytes: 65_536 });
});

test('#ExecServerMessageSchema rejects a stdin_ack of zero bytes', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'stdin_ack', bytes: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'too_small' });
});

test('#ExecServerMessageSchema accepts an error message with a code and data', () => {
  const result = ExecServerMessageSchema.safeParse({
    type: 'error',
    message: 'no imp named dev',
    code: 'NOT_FOUND',
    data: { name: 'dev' },
  });

  expect(result.data).toStrictEqual({
    type: 'error',
    message: 'no imp named dev',
    code: 'NOT_FOUND',
    data: { name: 'dev' },
  });
});

test('#ExecServerMessageSchema rejects an unknown server message type', () => {
  const result = ExecServerMessageSchema.safeParse({ type: 'stdout', bytes: 1 });

  expect(result.error?.issues).toPartiallyContain({ path: ['type'], code: 'invalid_union' });
});

test('#ExecAttachMessageSchema accepts an attach with its size and resume point', () => {
  const payload = {
    type: 'attach',
    name: 'dev',
    session: 'build',
    cols: 120,
    rows: 40,
    resumeFrom: { executionGeneration: '0123456789abcdef0123456789abcdef', offset: 4096 },
    wake: false,
  } as const;

  const result = ExecAttachMessageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ExecAttachMessageSchema accepts an attach with only its imp and session', () => {
  const payload = { type: 'attach', name: 'dev', session: 'build' } as const;

  expect(ExecAttachMessageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ExecAttachMessageSchema rejects a session name that is not a session name', () => {
  const result = ExecAttachMessageSchema.safeParse({
    type: 'attach',
    name: 'dev',
    session: 'Build',
    cols: 120,
    rows: 40,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['session'], code: 'invalid_format' });
});

test('#ExecAttachMessageSchema rejects an imp name that is not a name', () => {
  const result = ExecAttachMessageSchema.safeParse({
    type: 'attach',
    name: 'Dev',
    session: 'build',
    cols: 120,
    rows: 40,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test.each([
  ['cols', 0, 'too_small'],
  ['rows', 65_536, 'too_big'],
])('#ExecAttachMessageSchema rejects %s of %p with %s', (field, size, code) => {
  const result = ExecAttachMessageSchema.safeParse({
    type: 'attach',
    name: 'dev',
    session: 'build',
    cols: 120,
    rows: 40,
    [field]: size,
  });

  expect(result.error?.issues).toPartiallyContain({ path: [field], code });
});

test('#ExecAttachMessageSchema rejects a resume point with a bad generation', () => {
  const result = ExecAttachMessageSchema.safeParse({
    type: 'attach',
    name: 'dev',
    session: 'build',
    resumeFrom: { executionGeneration: 'not-hex', offset: 4096 },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['resumeFrom', 'executionGeneration'],
    code: 'invalid_format',
  });
});
