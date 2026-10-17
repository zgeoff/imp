import type { MovePlan, MoveStatus, WarmHost } from '@impz/api';
import { nameArg } from '../args/common-args';
import { toProgressOutput } from '../cli/command-io';
import { defineCommand } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import { loadCliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { ImpClient } from '../config/create-imp-client';
import { createCopyProgress } from '../cp/copy-progress';
import type { ProgressOutput } from '../cp/copy-progress';

// how often `impz move` asks the source how far the send is
const POLL_MS = 1000;

type MoveClient = Pick<ImpClient, 'moves' | 'system'>;

export interface MoveRun {
  readonly name: string;
  readonly from: MoveClient;
  readonly to: MoveClient;

  // the saved host the imp moves to, for messages
  readonly toHost: string;
  readonly mode: 'move' | 'resume' | 'abort';
  readonly stop: boolean;
  readonly output: ProgressOutput;
  readonly print: (line: string) => void;
  readonly wait: (ms: number) => Promise<void>;

  // the clock the send's progress reads its rate from
  readonly now: () => number;
}

// A whole move, as docs/guides/hosts.md#moves walks it: the source marks
// the imp, the target issues a ticket, the source streams and commits.
export async function runMove(run: MoveRun): Promise<void> {
  if (run.mode === 'abort') {
    const status = await run.from.moves.abort({ name: run.name });

    const line = status.isDone
      ? `${run.name}: ${run.toHost} had committed it already; the move is complete`
      : `${run.name}: move aborted; it stays here`;

    run.print(line);

    return;
  }

  if (run.mode === 'resume') {
    await runResume(run);

    return;
  }

  // a ZFS source sends ZFS streams to a ZFS target, else files; a sleeping
  // imp moves with its memory when the target's facts match
  const info = await run.to.system.info();
  const facts = await readFacts(run);

  const plan = await run.from.moves.prepare({
    name: run.name,
    stop: run.stop,

    // a person typed --stop: the imp's leases end rather than refuse it, as
    // with impz stop
    ...(run.stop && { force: true }),
    targetStorage: info.storage.backend,
    ...(facts !== null && { target: facts }),
  });

  const ticket = await requireTicket(run, plan);

  await run.from.moves.send({ name: run.name, to: ticket.peerUrl, ticket: ticket.ticket });

  const status = await waitForSend(run, plan.bytes);

  requireDone(run, status);

  const how = plan.warm === null ? '' : ', asleep with its memory';

  run.print(`${run.name}: moved to ${run.toHost}${how}`);
}

// an older target has no facts to give, and takes cold moves only
async function readFacts(run: MoveRun): Promise<WarmHost | null> {
  try {
    return await run.to.moves.facts();
  } catch {
    return null;
  }
}

// a refused ticket leaves the source marked: the mark comes off first
async function requireTicket(run: MoveRun, plan: Readonly<MovePlan>) {
  try {
    return await run.to.moves.receive({
      name: run.name,
      bytes: plan.bytes,
      ...(plan.warm !== null && { warm: plan.warm }),
    });
  } catch (error) {
    await run.from.moves.abort({ name: run.name });

    throw error;
  }
}

// A move the target verified, whose commit did not land: a fresh commit
// ticket from the target, and the source commits with it.
async function runResume(run: MoveRun): Promise<void> {
  const before = await run.from.moves.status({ name: run.name });

  if (before.state !== 'moved') {
    throw new UsageError(
      `${run.name} has no verified move to resume (state: ${before.state ?? 'none'}); run impz move again`,
    );
  }

  const ticket = await run.to.moves.reissue({ name: run.name });
  const status = await run.from.moves.resume({ name: run.name, ticket: ticket.ticket });

  requireDone(run, status);

  run.print(`${run.name}: moved to ${run.toHost}`);
}

async function waitForSend(run: MoveRun, totalBytes: number): Promise<MoveStatus> {
  const progress = createCopyProgress(run.output, run.now, 'impz move');
  let shown = 0;

  progress.setTotal(totalBytes);

  for (;;) {
    const status = await run.from.moves.status({ name: run.name });

    // the source counts its sent bytes again from 0 once the send is done,
    // so the line never steps back
    const sent = Math.max(status.sentBytes, shown);

    progress.add(sent - shown);

    shown = sent;

    if (status.isDone || status.error !== null) {
      progress.finish();

      return status;
    }

    await run.wait(POLL_MS);
  }
}

function requireDone(run: MoveRun, status: Readonly<MoveStatus>): void {
  if (status.isDone) {
    return;
  }

  throw new Error(
    `${run.name}: the move failed: ${status.error ?? 'unknown error'}${readFailureHint(run, status)}`,
  );
}

function readFailureHint(run: MoveRun, status: Readonly<MoveStatus>): string {
  // the target holds a verified copy: only a commit or an abort ends it
  if (status.state === 'moved') {
    return `; run impz move ${run.name} ${run.toHost} --resume, or --abort`;
  }

  // the target did not confirm the abort, so the mark stays on
  if (status.state === 'sending') {
    return `; the imp stays marked here: run impz move ${run.name} ${run.toHost} --abort once ${run.toHost} answers`;
  }

  return '; nothing changed on either host';
}

export const moveCommand = defineCommand({
  name: 'move',
  description:
    'Move an imp to another saved host: a stopped one cold, a sleeping one with its memory (see docs/guides/hosts.md)',
  args: {
    name: nameArg,
    to: { type: 'positional', description: 'saved host to move it to', required: true },
    stop: {
      type: 'boolean',
      description: 'stop a running or sleeping imp first, ending its leases: a cold move',
    },
    resume: { type: 'boolean', description: 'commit a move the target verified' },
    abort: { type: 'boolean', description: 'end a move; the imp stays here' },
  },
  run: async (ctx) => {
    await runAction(ctx.extensions.impz, async (client) => {
      if (ctx.values.resume === true && ctx.values.abort === true) {
        throw new UsageError('--resume and --abort do not go together');
      }

      const target = loadCliConfig(
        ctx.extensions.impz.io.env,
        ctx.values.to,
        ctx.extensions.impz.io.printError,
      );

      const mode = readMode(ctx.values.resume === true, ctx.values.abort === true);

      await runMove({
        name: ctx.values.name,
        from: client,
        to: createImpClient(target),
        toHost: ctx.values.to,
        mode,
        stop: ctx.values.stop === true,
        output: toProgressOutput(ctx.extensions.impz.io),
        print: (line) => {
          ctx.extensions.impz.io.print(line);
        },
        wait: (ms) => Bun.sleep(ms),
        now: Date.now,
      });
    });
  },
});

function readMode(isResume: boolean, isAbort: boolean): MoveRun['mode'] {
  if (isResume) {
    return 'resume';
  }

  return isAbort ? 'abort' : 'move';
}
