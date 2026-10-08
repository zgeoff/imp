import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubSilentBuildEngine } from './start-stub-silent-build-engine';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'idle-limited-build-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  // a release deferred here runs before the dir goes
  return { stack, dir };
}

test('it prints each outcome as a JSON line, with a cancelled build as its AbortError', async () => {
  const ctx = await setupTest();

  const ended = Promise.withResolvers<void>();

  const control = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'control-engine.sock'),
    imageId: `sha256:${'d'.repeat(64)}`,
    holdUntil: () => Promise.resolve(),
  });

  ctx.stack.defer(() => control.stop());

  const build = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'build-engine.sock'),
    imageId: `sha256:${'c'.repeat(64)}`,
    holdUntil: () => Promise.resolve(),
  });

  ctx.stack.defer(() => build.stop());

  const cancelled = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'cancel-engine.sock'),
    imageId: `sha256:${'e'.repeat(64)}`,
    holdUntil: () => ended.promise,
  });

  ctx.stack.defer(() => cancelled.stop());

  ctx.stack.defer(() => {
    ended.resolve();
  });

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-idle-limited-docker-build.ts'),
      JSON.stringify({
        dir: ctx.dir,
        buildEngine: join(ctx.dir, 'build-engine.sock'),
        cancelEngine: join(ctx.dir, 'cancel-engine.sock'),
        controlEngine: join(ctx.dir, 'control-engine.sock'),
      }),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(() => {
    child.kill();
  });

  await cancelled.started;

  await child.stdin.write('control\n');
  await child.stdin.flush();

  await control.started;

  await child.stdin.write('cancel\n');
  await child.stdin.flush();

  const output = await new Response(child.stdout).text();

  const exitCode = await child.exited;

  const lines: unknown[] = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(exitCode).toBe(0);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: true },
    { kind: 'build', isOk: true, id: `sha256:${'c'.repeat(64)}` },
    { kind: 'cancel', isOk: false, error: { name: 'AbortError', code: 20 } },
  ]);
});

test('it starts the unprotected fetch only on a control line', async () => {
  const ctx = await setupTest();

  const control = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'control-engine.sock'),
    imageId: `sha256:${'d'.repeat(64)}`,
    holdUntil: () => Promise.resolve(),
  });

  ctx.stack.defer(() => control.stop());

  const build = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'build-engine.sock'),
    imageId: `sha256:${'c'.repeat(64)}`,
    holdUntil: () => Promise.resolve(),
  });

  ctx.stack.defer(() => build.stop());

  const cancelled = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'cancel-engine.sock'),
    imageId: `sha256:${'e'.repeat(64)}`,
    holdUntil: () => Promise.resolve(),
  });

  ctx.stack.defer(() => cancelled.stop());

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-idle-limited-docker-build.ts'),
      JSON.stringify({
        dir: ctx.dir,
        buildEngine: join(ctx.dir, 'build-engine.sock'),
        cancelEngine: join(ctx.dir, 'cancel-engine.sock'),
        controlEngine: join(ctx.dir, 'control-engine.sock'),
      }),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );

  ctx.stack.defer(() => {
    child.kill();
  });

  // both builds have run to their image, and the control has had its chance
  await Promise.all([build.closed, cancelled.closed]);

  const controlState = await Promise.race([
    control.started.then(() => 'started'),
    Promise.resolve('waiting'),
  ]);

  expect(controlState).toBe('waiting');
});
