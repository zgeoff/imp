import { expect, test } from 'bun:test';
import { buildMockSessionOutput } from './build-mock-session-output';
import { buildStubTapOpener } from './build-stub-tap-opener';
import { buildStubTapStream } from './build-stub-tap-stream';

test('it answers each tap with the next answer the test queued', async () => {
  const opener = buildStubTapOpener();
  const first = buildStubTapStream(buildMockSessionOutput());
  const second = buildStubTapStream(buildMockSessionOutput());

  opener.answers.push(
    () => Promise.resolve(first.stream),
    () => Promise.resolve(second.stream),
  );

  const opened = await opener.openTap('/nonexistent/vsock.sock', 'main');
  const reopened = await opener.openTap('/nonexistent/vsock.sock', 'main');

  expect(opened).toBe(first.stream);
  expect(reopened).toBe(second.stream);
});

test('it records the session and resume point of each tap', async () => {
  const opener = buildStubTapOpener();
  const tap = buildStubTapStream(buildMockSessionOutput());

  opener.answers.push(
    () => Promise.resolve(tap.stream),
    () => Promise.resolve(tap.stream),
  );

  await opener.openTap('/nonexistent/vsock.sock', 'main');

  await opener.openTap('/nonexistent/vsock.sock', 'other', {
    executionGeneration: 'a'.repeat(32),
    offset: 7,
  });

  expect(opener.calls).toStrictEqual([
    { session: 'main', resumeFrom: undefined },
    { session: 'other', resumeFrom: { executionGeneration: 'a'.repeat(32), offset: 7 } },
  ]);
});

test('it refuses a tap with nothing queued', () => {
  const opener = buildStubTapOpener();

  expect(opener.openTap('/nonexistent/vsock.sock', 'main')).rejects.toThrowWithMessage(
    Error,
    'no tap queued',
  );
});
