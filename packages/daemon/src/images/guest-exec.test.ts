import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StubAnswer } from '../test-utils/build-stub-guest';
import { buildStubGuest } from '../test-utils/build-stub-guest';
import { GuestOutputError, createGuestExec } from './guest-exec';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-guest-exec-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it runs a step as root and gives its exit code, stdout and stderr', async () => {
  const guest = buildStubGuest(() => ({ stdout: 'out\n', stderr: 'err\n', code: 3 }));

  const result = await createGuestExec(guest.open)(['docker', 'version'], {
    signal: new AbortController().signal,
  });

  expect(result).toStrictEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
});

test('it sends a file to the step as its stdin', async () => {
  const ctx = await setupTest();

  const stdin = Promise.withResolvers<string>();

  const guest = buildStubGuest(async (run) => {
    const bytes = await run.readStdin();

    stdin.resolve(new TextDecoder().decode(bytes));

    return {};
  });

  writeFileSync(join(ctx.dir, 'context.tar'), 'the context');

  await createGuestExec(guest.open)(['docker', 'build', '-'], {
    stdinPath: join(ctx.dir, 'context.tar'),
    signal: new AbortController().signal,
  });

  expect(stdin.promise).resolves.toBe('the context');
});

test('it rethrows at the exit the error that stopped the stdin', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({}));

  expect(
    createGuestExec(guest.open)(['docker', 'build', '-'], {
      stdinPath: join(ctx.dir, 'missing.tar'),
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it hands each stdout chunk to onStdout and keeps none of it', async () => {
  const chunks: string[] = [];

  const guest = buildStubGuest(() => ({
    stdout: ['a', 'b'].map((text) => new TextEncoder().encode(text)),
  }));

  const result = await createGuestExec(guest.open)(['docker', 'export', 'c'], {
    signal: new AbortController().signal,
    onStdout: (chunk) => {
      chunks.push(new TextDecoder().decode(chunk));

      return Promise.resolve();
    },
  });

  expect(chunks).toStrictEqual(['a', 'b']);
  expect(result.stdout).toBe('');
});

test('it refuses a step that writes past the stdout impd keeps', () => {
  const guest = buildStubGuest(() => ({
    stdout: ['x'.repeat(1024 ** 2), 'y'].map((text) => new TextEncoder().encode(text)),
  }));

  expect(
    createGuestExec(guest.open)(['cat'], { signal: new AbortController().signal }),
  ).rejects.toThrowWithMessage(GuestOutputError, 'cat: wrote more than 1048576 bytes');
});

test('it fails a step that does not exit within its timeout', () => {
  const guest = buildStubGuest(() => new Promise<StubAnswer>(() => {}));

  expect(
    createGuestExec(guest.open)(['sleep', 'inf'], {
      signal: new AbortController().signal,
      timeoutMs: 20,
    }),
  ).rejects.toThrowWithMessage(Error, 'sleep inf: no exit in 20 ms');
});

test('it kills and closes a step that does not exit within its timeout', () => {
  const guest = buildStubGuest(() => new Promise<StubAnswer>(() => {}));

  const running = createGuestExec(guest.open)(['sleep', 'inf'], {
    signal: new AbortController().signal,
    timeoutMs: 20,
  });

  expect(running).rejects.toThrowWithMessage(Error, 'sleep inf: no exit in 20 ms');
  expect(guest.runs[0]).toMatchObject({ signals: [9], closed: true });
});

test('it kills and closes a running step whose signal aborts', async () => {
  const guest = buildStubGuest(() => ({ stdout: 'started', stall: true }));

  const controller = new AbortController();

  const started = Promise.withResolvers<void>();

  const running = createGuestExec(guest.open)(['sleep', 'inf'], {
    signal: controller.signal,
    onStdout: () => {
      started.resolve();

      return Promise.resolve();
    },
  });

  await started.promise;

  controller.abort();

  expect(running).rejects.toMatchObject({ name: 'AbortError' });
  expect(guest.runs[0]).toMatchObject({ signals: [9], closed: true });
});

test('it closes a step whose signal aborts while it opens', () => {
  const guest = buildStubGuest(() => new Promise<StubAnswer>(() => {}));

  const controller = new AbortController();

  const running = createGuestExec(guest.open)(['sleep', 'inf'], { signal: controller.signal });

  controller.abort();

  expect(running).rejects.toMatchObject({ name: 'AbortError' });
  expect(guest.runs[0]).toMatchObject({ signals: [], closed: true });
});

test('it opens no step once its signal aborted', () => {
  const guest = buildStubGuest(() => ({}));

  expect(
    createGuestExec(guest.open)(['docker', 'version'], { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(guest.runs).toStrictEqual([]);
});

test("it fails a step whose builder's agent closed the exec before its exit", () => {
  const guest = buildStubGuest(() => ({ stdout: 'partial', isDropped: true }));

  expect(
    createGuestExec(guest.open)(['docker', 'version'], { signal: new AbortController().signal }),
  ).rejects.toThrowWithMessage(
    Error,
    "docker version: the builder's agent closed the exec before its exit",
  );
});
