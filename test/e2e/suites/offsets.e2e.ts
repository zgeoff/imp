import { expect, test } from 'bun:test';
import * as z from 'zod';
import { openSessionSocket, requireOutput } from '../lib/exec-socket';
import type { SessionOutput, SessionSocket } from '../lib/exec-socket';
import { resolveImageName } from '../lib/fixtures';
import { assertState, requireImp, runImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Session output offsets (docs/architecture/daemon.md#output-offsets): a
// client resumes from the byte it last saw, and learns what it missed.

const prefix = setupSuite('offsets');
const BARE = resolveImageName('e2e-bare');
const name = `${prefix}a`;
const MIB = 1_048_576;
const RING_BYTES = 262_144;

// exactly 1 MiB of output, untouched by the tty (no CR before LF, no echo),
// then a process that writes nothing more
const PRODUCER = [
  'sh',
  '-c',
  `stty -opost -echo; head -c ${String(MIB)} /dev/zero | tr '\\0' x; exec sleep 3600`,
];

const ColdBootRowSchema = z.object({ bootId: z.string(), cause: z.string() });

const ErrorDataSchema = z.object({
  bootId: z.string().optional(),
  state: z.string().optional(),
  coldBoots: z.array(ColdBootRowSchema),
});

// what the steps carry forward: the client's generation and boot
const seen: { output: SessionOutput | null } = { output: null };

function requireSeen(): SessionOutput {
  if (seen.output === null) {
    throw new Error('no session output from an earlier step');
  }

  return seen.output;
}

function readError(opened: Readonly<SessionSocket>) {
  if (opened.first.type !== 'error') {
    throw new Error(`expected an error, got ${JSON.stringify(opened.first)}`);
  }

  return { code: opened.first.code, data: ErrorDataSchema.parse(opened.first.data) };
}

function startProducer() {
  return openSessionSocket({ type: 'start', name, session: 'out', argv: PRODUCER, tty: true });
}

function openResume(offset: number, generation = requireSeen().executionGeneration) {
  return openSessionSocket({
    type: 'attach',
    name,
    session: 'out',
    resumeFrom: { executionGeneration: generation, offset },
  });
}

// the Firecracker of the imp, by the imp id in its API socket path
async function stopFirecracker(id: string): Promise<void> {
  const found = await runInContainer(['pgrep', '-f', `/imps/${id}/run/api.sock`]);

  const pids = found.stdout.split('\n').filter((pid) => pid !== '');

  if (pids.length === 0) {
    throw new Error(`no firecracker for imp ${id}`);
  }

  for (const pid of pids) {
    await runInContainer(['kill', '-9', pid]);
  }
}

test('1 MiB of output, then a resume from 0, gives a gap and exactly the ring', async () => {
  await createImp(name, '--image', BARE, '--memory', '256');

  const producer = await startProducer();

  const started = requireOutput(producer);

  await producer.readBytes(MIB);

  producer.close();

  const opening = performance.now();

  const resumed = await openResume(0, started.executionGeneration);

  const output = requireOutput(resumed);

  const data = await resumed.readBytes(RING_BYTES);

  const resumeMs = Math.round(performance.now() - opening);

  resumed.close();

  seen.output = output;

  writeMetric('offsets_gap_resume_ms', resumeMs);

  expect(started).toMatchObject({ offset: 0, prelude: 0, bufferStart: 0 });
  expect(started.coldBoots[0]).toMatchObject({ bootId: started.bootId, cause: 'start' });

  expect(output).toMatchObject({
    executionGeneration: started.executionGeneration,
    bufferStart: MIB - RING_BYTES,
    end: MIB,
    offset: MIB - RING_BYTES,
    prelude: 0,
    resume: { kind: 'gap', from: 0, to: MIB - RING_BYTES },
  });

  expect(data.byteLength).toBe(RING_BYTES);
  expect(data.every((byte) => byte === 120)).toBeTrue();
});

test('a sleep and a memory wake keep the generation: the resume is exact', async () => {
  const before = requireSeen();

  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  const resumed = await openResume(MIB - 100);

  const output = requireOutput(resumed);

  const data = await resumed.readBytes(100);

  resumed.close();

  expect(output).toMatchObject({
    bootId: before.bootId,
    executionGeneration: before.executionGeneration,
    offset: MIB - 100,
    end: MIB,
    resume: { kind: 'exact' },
  });

  expect(output.coldBoots).toEqual(before.coldBoots);
  expect(data.byteLength).toBe(100);
});

test('wake: false on a stopped imp fails with INVALID_STATE and boots nothing', async () => {
  await runImp('stop', name);

  const refused = await openSessionSocket({ type: 'attach', name, session: 'out', wake: false });

  const error = readError(refused);

  refused.close();

  await assertState(name, 'stopped');

  expect(error.code).toBe('INVALID_STATE');
  expect(error.data.state).toBe('stopped');
  expect(error.data.coldBoots[0]?.bootId).toBe(requireSeen().bootId);
});

test('a stop and start end the generation: NO_SESSION, then generation_changed, cause start', async () => {
  const before = requireSeen();

  await runImp('start', name);

  const gone = await openResume(MIB);

  const error = readError(gone);

  gone.close();

  const restarted = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: PRODUCER,
    tty: true,
    resumeFrom: { executionGeneration: before.executionGeneration, offset: MIB },
  });

  const output = requireOutput(restarted);

  restarted.close();

  seen.output = output;

  expect(error.code).toBe('NO_SESSION');
  expect(error.data.bootId).not.toBe(before.bootId);
  expect(error.data.coldBoots.map((boot) => boot.cause).slice(0, 2)).toEqual(['start', 'start']);
  expect(error.data.coldBoots[1]?.bootId).toBe(before.bootId);
  expect(output.executionGeneration).not.toBe(before.executionGeneration);
  expect(output.coldBoots[0]).toMatchObject({ bootId: output.bootId, cause: 'start' });

  expect(output.resume).toEqual({
    kind: 'generation_changed',
    executionGeneration: output.executionGeneration,
    firstOffset: 0,
  });
});

test('a checkpoint restore ends the generation with the cause restore', async () => {
  await runImp('checkpoint', name, 'offsets');
  await runImp('restore', name, 'offsets');

  const gone = await openResume(0);

  const error = readError(gone);

  gone.close();

  expect(error.code).toBe('NO_SESSION');
  expect(error.data.coldBoots[0]?.cause).toBe('restore');
  expect(error.data.coldBoots[1]?.bootId).toBe(requireSeen().bootId);
});

test('a killed VM ends the generation with the cause recovery, which the attach that boots keeps', async () => {
  const producer = await startProducer();

  const before = requireOutput(producer);

  producer.close();

  seen.output = before;

  const imp = await requireImp(name);

  await stopFirecracker(imp.id);

  // the attach finds the VM gone, and boots the imp to answer
  const gone = await waitFor('an attach after the kill', async () => {
    const opened = await openResume(0);

    opened.close();

    return readError(opened);
  });

  expect(gone.code).toBe('NO_SESSION');
  expect(gone.data.coldBoots[0]?.cause).toBe('recovery');
  expect(gone.data.coldBoots[1]?.bootId).toBe(before.bootId);
});
