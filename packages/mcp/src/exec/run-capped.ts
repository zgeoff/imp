import type { ExecHandle, ImpClient } from '@zgeoff/imp-client';
import { ExecError } from '@zgeoff/imp-client';
import { createOutputCollector } from './output-cap';
import type { CappedOutput } from './output-cap';

export interface CappedRunOptions {
  readonly argv: readonly string[];
  readonly stdin?: Uint8Array;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;

  // per stream; see output-cap.ts
  readonly maxOutputBytes: number;
  readonly headBytes: number;

  // the tool call's cancel
  readonly signal: Readonly<AbortSignal>;

  // how long SIGTERM, then SIGKILL, get before the next step
  readonly killGraceMs: number;
}

export interface CappedRunResult {
  // null when a signal ended the command, or it never reported an exit
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: CappedOutput;
  readonly stderr: CappedOutput;
}

type Stop = 'exited' | 'timeout' | 'cancel';

// Runs a command in an imp to its exit, its deadline or a cancel, which
// throws once the command stopped. A closed socket only sends SIGHUP, which
// nohup ignores, so a stop signals the process group: SIGTERM, then SIGKILL.
export async function runCapped(
  openExec: ImpClient['openExec'],
  name: string,
  options: Readonly<CappedRunOptions>,
): Promise<CappedRunResult> {
  const deadline = AbortSignal.timeout(options.timeoutMs);

  options.signal.throwIfAborted();

  const handle = await openExec(name, options.argv, {
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.env !== undefined && { env: options.env }),
  });

  const stdout = createOutputCollector(options.maxOutputBytes, options.headBytes);
  const stderr = createOutputCollector(options.maxOutputBytes, options.headBytes);

  const reading = Promise.all([
    drain(handle.stdout, stdout.push),
    drain(handle.stderr, stderr.push),
  ]);

  void writeStdin(handle, options.stdin);

  const stop = await waitForStop(handle, [options.signal, deadline]);

  if (stop !== 'exited') {
    await stopCommand(handle, options.killGraceMs);
  }

  const exit = await readExit(handle, stop);

  await reading;

  if (stop === 'cancel') {
    options.signal.throwIfAborted();
  }

  return {
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    timedOut: stop === 'timeout',
    stdout: stdout.finish(),
    stderr: stderr.finish(),
  };
}

// the first of: the command's exit (or the session's end), the cancel, the
// deadline. A start that fails throws, as `exit` does.
async function waitForStop(
  handle: Readonly<ExecHandle>,
  [cancel, deadline]: readonly [Readonly<AbortSignal>, Readonly<AbortSignal>],
): Promise<Stop> {
  const stopped = Promise.withResolvers<Stop>();

  const onCancel = (): void => {
    stopped.resolve('cancel');
  };

  const onDeadline = (): void => {
    stopped.resolve('timeout');
  };

  cancel.addEventListener('abort', onCancel, { once: true });
  deadline.addEventListener('abort', onDeadline, { once: true });

  void (async () => {
    await waitSettled(handle.exit);

    stopped.resolve('exited');
  })();

  try {
    await handle.started;

    if (cancel.aborted) {
      return 'cancel';
    }

    if (deadline.aborted) {
      return 'timeout';
    }

    return await stopped.promise;
  } catch (error) {
    handle.close();
    throw error;
  } finally {
    cancel.removeEventListener('abort', onCancel);
    deadline.removeEventListener('abort', onDeadline);
  }
}

async function stopCommand(handle: Readonly<ExecHandle>, graceMs: number): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    handle.sendSignal(signal);

    const exited = await waitForExit(handle, graceMs);

    if (exited) {
      return;
    }
  }

  handle.close();
}

// whether the session ended within `ms`
async function waitForExit(handle: Readonly<ExecHandle>, ms: number): Promise<boolean> {
  const settled = (async () => {
    await waitSettled(handle.exit);

    return true;
  })();

  const timer = Promise.withResolvers<boolean>();

  const timeout = setTimeout(() => {
    timer.resolve(false);
  }, ms);

  try {
    return await Promise.race([settled, timer.promise]);
  } finally {
    clearTimeout(timeout);
  }
}

// the exit, or null for a command stopped without one; a session that ended
// for another reason (impd restarting, the imp destroyed) throws
async function readExit(
  handle: Readonly<ExecHandle>,
  stop: Stop,
): Promise<{ readonly code: number | null; readonly signal: string | null } | null> {
  try {
    return await handle.exit;
  } catch (error) {
    if (stop !== 'exited' && error instanceof ExecError && error.code === 'CLOSED') {
      return null;
    }

    throw error;
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  push: (chunk: Uint8Array) => void,
): Promise<void> {
  for await (const chunk of stream) {
    push(chunk);
  }
}

// a command that exits before reading its stdin makes the write fail; its
// exit says what happened
async function writeStdin(
  handle: Readonly<ExecHandle>,
  stdin: Uint8Array | undefined,
): Promise<void> {
  try {
    if (stdin !== undefined && stdin.byteLength > 0) {
      await handle.write(stdin);
    }

    await handle.closeStdin();
  } catch {
    // see above
  }
}

async function waitSettled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller reads the outcome where it needs it
  }
}
