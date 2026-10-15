import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { config } from '../lib/config';
import { openSessionSocket, requireOutput, requireSessionError } from '../lib/exec-socket';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, requireImp, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { stopFirecrackerHard } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Session output offsets (docs/architecture/daemon.md#output-offsets): a
// client resumes from the byte it last saw, and learns what it missed.

// one stack for every release, so each session socket closes before its imp
// goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('offsets'), stack, client };
}

test('it resumes session output from the offset a client saw, and names the gap, the new generation and the cause of each cold boot', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;
  const mib = 1_048_576;

  // impd's ring of session output per session
  const ringBytes = 262_144;

  // exactly 1 MiB of output, untouched by the tty (no CR before LF, no echo),
  // then a process that writes nothing more
  const producer = [
    'sh',
    '-c',
    `stty -opost -echo; head -c ${String(mib)} /dev/zero | tr '\\0' x; exec sleep 3600`,
  ];

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const started = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: producer,
    tty: true,
  });

  ctx.stack.defer(() => {
    started.close();
  });

  const startedOutput = requireOutput(started);

  await started.readBytes(mib);

  started.close();

  const opening = performance.now();

  const gapResume = await openSessionSocket({
    type: 'attach',
    name,
    session: 'out',
    resumeFrom: { executionGeneration: startedOutput.executionGeneration, offset: 0 },
  });

  ctx.stack.defer(() => {
    gapResume.close();
  });

  const gapOutput = requireOutput(gapResume);

  const ring = await gapResume.readBytes(ringBytes);

  const resumeMs = Math.round(performance.now() - opening);

  gapResume.close();

  writeMetric('offsets_gap_resume_ms', resumeMs);

  expect(startedOutput).toMatchObject({ offset: 0, prelude: 0, bufferStart: 0 });

  expect(startedOutput.coldBoots[0]).toMatchObject({
    bootId: startedOutput.bootId,
    cause: 'start',
  });

  expect(gapOutput).toMatchObject({
    executionGeneration: startedOutput.executionGeneration,
    bufferStart: mib - ringBytes,
    end: mib,
    offset: mib - ringBytes,
    prelude: 0,
    resume: { kind: 'gap', from: 0, to: mib - ringBytes },
  });

  expect(new TextDecoder().decode(ring)).toBe('x'.repeat(ringBytes));

  // a sleep and a memory wake keep the generation, so the resume is exact
  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  const exactResume = await openSessionSocket({
    type: 'attach',
    name,
    session: 'out',
    resumeFrom: { executionGeneration: gapOutput.executionGeneration, offset: mib - 100 },
  });

  ctx.stack.defer(() => {
    exactResume.close();
  });

  const exactOutput = requireOutput(exactResume);

  const tail = await exactResume.readBytes(100);

  exactResume.close();

  expect(exactOutput).toMatchObject({
    bootId: gapOutput.bootId,
    executionGeneration: gapOutput.executionGeneration,
    offset: mib - 100,
    end: mib,
    resume: { kind: 'exact' },
  });

  expect(exactOutput.coldBoots).toStrictEqual(gapOutput.coldBoots);
  expect(new TextDecoder().decode(tail)).toBe('x'.repeat(100));

  // wake: false on a stopped imp boots nothing
  await runImp('stop', name);

  const refused = await openSessionSocket({ type: 'attach', name, session: 'out', wake: false });

  ctx.stack.defer(() => {
    refused.close();
  });

  const refusal = requireSessionError(refused);

  refused.close();

  await assertState(name, 'stopped');

  expect(refusal.code).toBe('INVALID_STATE');
  expect(refusal.data.state).toBe('stopped');
  expect(refusal.data.coldBoots[0]?.bootId).toBe(exactOutput.bootId);

  // a stop and a start end the generation
  await runImp('start', name);

  const afterStart = await openSessionSocket({
    type: 'attach',
    name,
    session: 'out',
    resumeFrom: { executionGeneration: exactOutput.executionGeneration, offset: mib },
  });

  ctx.stack.defer(() => {
    afterStart.close();
  });

  const startGone = requireSessionError(afterStart);

  afterStart.close();

  const restarted = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: producer,
    tty: true,
    resumeFrom: { executionGeneration: exactOutput.executionGeneration, offset: mib },
  });

  ctx.stack.defer(() => {
    restarted.close();
  });

  const restartedOutput = requireOutput(restarted);

  restarted.close();

  expect(startGone.code).toBe('NO_SESSION');

  invariant(startGone.data.bootId);

  expect(startGone.data.bootId).not.toBe(exactOutput.bootId);

  expect(startGone.data.coldBoots.map((boot) => boot.cause).slice(0, 2)).toStrictEqual([
    'start',
    'start',
  ]);

  expect(startGone.data.coldBoots[1]?.bootId).toBe(exactOutput.bootId);
  expect(restartedOutput.executionGeneration).not.toBe(exactOutput.executionGeneration);

  expect(restartedOutput.coldBoots[0]).toMatchObject({
    bootId: restartedOutput.bootId,
    cause: 'start',
  });

  expect(restartedOutput.resume).toStrictEqual({
    kind: 'generation_changed',
    executionGeneration: restartedOutput.executionGeneration,
    firstOffset: 0,
  });

  // a checkpoint restore ends the generation with the cause restore
  await runImp('checkpoint', name, 'offsets');
  await runImp('restore', name, 'offsets');

  const afterRestore = await openSessionSocket({
    type: 'attach',
    name,
    session: 'out',
    resumeFrom: { executionGeneration: restartedOutput.executionGeneration, offset: 0 },
  });

  ctx.stack.defer(() => {
    afterRestore.close();
  });

  const restoreGone = requireSessionError(afterRestore);

  afterRestore.close();

  expect(restoreGone.code).toBe('NO_SESSION');
  expect(restoreGone.data.coldBoots[0]?.cause).toBe('restore');
  expect(restoreGone.data.coldBoots[1]?.bootId).toBe(restartedOutput.bootId);

  // a killed VM ends the generation with the cause recovery, which the
  // attach that boots the imp keeps
  const beforeKill = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: producer,
    tty: true,
  });

  ctx.stack.defer(() => {
    beforeKill.close();
  });

  const beforeKillOutput = requireOutput(beforeKill);

  beforeKill.close();

  const imp = await requireImp(name);

  await stopFirecrackerHard(imp.id);

  // the attach finds the VM gone, and boots the imp to answer
  const recoveryGone = await waitFor('an attach after the kill', async () => {
    const opened = await openSessionSocket({
      type: 'attach',
      name,
      session: 'out',
      resumeFrom: { executionGeneration: beforeKillOutput.executionGeneration, offset: 0 },
    });

    opened.close();

    return requireSessionError(opened);
  });

  expect(recoveryGone.code).toBe('NO_SESSION');
  expect(recoveryGone.data.coldBoots[0]?.cause).toBe('recovery');
  expect(recoveryGone.data.coldBoots[1]?.bootId).toBe(beforeKillOutput.bootId);
});
