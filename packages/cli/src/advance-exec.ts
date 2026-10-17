import { constants } from 'node:os';
import type { ExecOutcome } from '@impz/client';
import type { CliConfig } from './cli-config';
import { formatUnauthorized } from './run-action';

// Exit codes as ssh and shells use them (docs/guides/cli.md has the table): 1 a
// --require impd cannot meet, 127 could not start, 141 our output went away,
// 254 another client took the session over, 255 imp failed. A detach exits 0.
const PRECONDITION_FAILED_CODE = 1;
const EXEC_FAILED_CODE = 127;
const BROKEN_PIPE_CODE = 141;
const TAKEN_OVER_CODE = 254;
const IMP_FAILED_CODE = 255;

// the imp answers, but the container its commands run in is down
const INNER_DOWN_HINT =
  ' (the container in the imp starts again on its own; impz stop and impz start, or impz restore, bring it back)';

// the most a pause between two attaches grows to
const REATTACH_MAX_DELAY_MS = 8000;

// What one `impz exec` has decided so far, apart from its sockets, stdin and
// terminal: whether its session started, and how long a lost one is tried
// again. Only advanceExec moves it.
export interface ExecMachine {
  readonly imp: string;

  // the session the command runs in, or null for one that ends with the CLI
  readonly session: string | null;
  readonly config: CliConfig;

  // how long a lost session is tried again, and the first pause between
  // tries; each later pause doubles, up to REATTACH_MAX_DELAY_MS
  readonly windowMs: number;
  readonly firstDelayMs: number;

  // a session that never started has nothing to attach to again
  readonly started: boolean;

  // set while a lost session is being attached again
  readonly reattachUntil: number | null;
  readonly tries: number;
}

export type ExecEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'outcome'; readonly outcome: ExecOutcome; readonly now: number }

  // another client holds the session the CLI would attach to again
  | { readonly kind: 'taken_over' };

export type ExecStep =
  | { readonly kind: 'attached'; readonly wasAway: boolean }

  // the exit code, and the line for stderr once the terminal is reset
  | { readonly kind: 'stop'; readonly code: number; readonly message: string | null }
  | { readonly kind: 'reattach'; readonly delayMs: number; readonly isFirst: boolean };

export interface ExecTransition {
  readonly machine: ExecMachine;
  readonly step: ExecStep;
}

// The next state of an exec and what runExec does about the event, from the
// two alone: an outcome either ends the CLI with its exit code or, for a
// session that is only away, tries it again after a pause.
export function advanceExec(machine: Readonly<ExecMachine>, event: ExecEvent): ExecTransition {
  switch (event.kind) {
    case 'started': {
      return {
        machine: { ...machine, started: true, reattachUntil: null, tries: 0 },
        step: { kind: 'attached', wasAway: machine.reattachUntil !== null },
      };
    }
    case 'taken_over': {
      return {
        machine,
        step: {
          kind: 'stop',
          code: TAKEN_OVER_CODE,
          message: `another client attached to ${formatSession(machine)}`,
        },
      };
    }
    case 'outcome': {
      if (!canReattach(machine, event.outcome, event.now)) {
        const result = buildOutcomeResult(event.outcome, machine.config, formatSession(machine));

        return { machine, step: { kind: 'stop', ...result } };
      }

      const tries = machine.tries + 1;
      const delayMs = Math.min(machine.firstDelayMs * 2 ** (tries - 1), REATTACH_MAX_DELAY_MS);
      const reattachUntil = machine.reattachUntil ?? event.now + machine.windowMs;

      return {
        machine: { ...machine, reattachUntil, tries },
        step: { kind: 'reattach', delayMs, isFirst: machine.reattachUntil === null },
      };
    }
    default: {
      return event satisfies never;
    }
  }
}

// `session main (impz attach box main)`: the session, and how to get back
export function formatSession(machine: Readonly<Pick<ExecMachine, 'imp' | 'session'>>): string {
  const session = machine.session ?? '';

  return `session ${session} (impz attach ${machine.imp} ${session})`;
}

// whether the outcome leaves the session running, so the CLI may attach
// again: never after another client took it over, or once the window is over
function canReattach(machine: Readonly<ExecMachine>, outcome: ExecOutcome, now: number): boolean {
  if (machine.session === null || !machine.started) {
    return false;
  }

  if (machine.reattachUntil !== null && now >= machine.reattachUntil) {
    return false;
  }

  if (outcome.kind === 'detached') {
    return outcome.reason === 'lost' || outcome.reason === 'slow';
  }

  return outcome.kind === 'closed' || outcome.kind === 'unreachable';
}

interface OutcomeResult {
  readonly code: number;

  // the line for stderr, printed once the terminal is reset
  readonly message: string | null;
}

// the exit code for an outcome, and the line that explains a failure
function buildOutcomeResult(
  outcome: ExecOutcome,
  config: CliConfig,
  session: string,
): OutcomeResult {
  switch (outcome.kind) {
    case 'exit': {
      if (outcome.code !== null) {
        return { code: outcome.code, message: null };
      }

      const signal = readSignalNumber(outcome.signal);

      if (signal === 0) {
        return {
          code: IMP_FAILED_CODE,
          message: 'impd reported an exit with no code and no known signal',
        };
      }

      return { code: 128 + signal, message: null };
    }
    case 'failed': {
      const prefix = outcome.code === null ? '' : `${outcome.code}: `;
      const code = pickFailedCode(outcome.code);
      const hint = outcome.code === 'INNER_DOWN' ? INNER_DOWN_HINT : '';

      return { code, message: `${prefix}${outcome.message}${hint}` };
    }
    case 'detached': {
      if (outcome.reason === 'taken_over') {
        return { code: TAKEN_OVER_CODE, message: `another client attached to ${session}` };
      }

      const why =
        outcome.reason === 'slow' ? 'this terminal fell behind' : 'the connection was lost';

      return { code: IMP_FAILED_CODE, message: `detached, ${why}: ${session}` };
    }
    case 'unauthorized': {
      return { code: IMP_FAILED_CODE, message: formatUnauthorized(config) };
    }
    case 'unreachable': {
      return {
        code: IMP_FAILED_CODE,
        message: `cannot reach impd at ${config.url} (${outcome.detail})`,
      };
    }
    case 'closed': {
      return { code: IMP_FAILED_CODE, message: `exec connection closed (${outcome.reason})` };
    }
    case 'bad_message': {
      return { code: IMP_FAILED_CODE, message: `bad message from impd: ${outcome.detail}` };
    }
    case 'local_error': {
      break;
    }
  }

  // a callback threw; a reader such as `head` that went away is quiet, as
  // for a local command
  if (isBrokenPipe(outcome.error)) {
    return { code: BROKEN_PIPE_CODE, message: null };
  }

  const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);

  return { code: IMP_FAILED_CODE, message };
}

// what a refusal exits with: 127 for a command that could not start, 1 for
// a requirement impd cannot meet, as for any refused call, else 255
function pickFailedCode(code: string | null): number {
  if (code === 'EXEC_FAILED') {
    return EXEC_FAILED_CODE;
  }

  return code === 'PRECONDITION_FAILED' ? PRECONDITION_FAILED_CODE : IMP_FAILED_CODE;
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE';
}

// impd names a signal Node does not know (a real-time one) `SIG<n>`
export function readSignalNumber(signal: string | null): number {
  if (signal === null) {
    return 0;
  }

  const signals: Readonly<Record<string, number>> = constants.signals;
  const numbered = /^SIG(?<number>\d+)$/u.exec(signal)?.groups?.['number'];

  return signals[signal] ?? (numbered === undefined ? 0 : Number(numbered));
}
