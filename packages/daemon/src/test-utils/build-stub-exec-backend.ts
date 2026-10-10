import { ORPCError } from '@orpc/server';
import type { AgentFeature } from '../agent-client/agent-outdated';
import type { AgentAttachRequest, AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { buildInvalidStateError } from '../api-errors';
import type { ExecBackend } from '../exec/exec-session';

type StubOpen =
  | {
      readonly kind: 'exec';
      readonly name: string;
      readonly request: AgentExecRequest;
      readonly feature: AgentFeature | undefined;
    }
  | { readonly kind: 'attach'; readonly name: string; readonly request: AgentAttachRequest };

interface StubExecBackendOptions {
  // what an exec opens to: a stream, or an error it rejects with
  readonly exec?: ExecStream | Error;

  // what an attach opens to, likewise
  readonly attach?: ExecStream | Error;
}

// The imp service behind an `/exec` socket: `opens` records each open, and
// `activity` each imp a session reports once its stream ends. An open given
// no outcome is refused as a stopped imp's unwoken attach (see openOutcome).
export function buildStubExecBackend(options: StubExecBackendOptions = {}) {
  const opens: StubOpen[] = [];
  const activity: string[] = [];

  const backend: ExecBackend = {
    openExec: (name, request, feature) => {
      opens.push({ kind: 'exec', name, request, feature });

      return openOutcome(options.exec);
    },
    openAttach: (name, request) => {
      opens.push({ kind: 'attach', name, request });

      return openOutcome(options.attach);
    },
    recordActivity: (name) => {
      activity.push(name);

      return Promise.resolve();
    },
  };

  return { backend, opens, activity };
}

function openOutcome(outcome: ExecStream | Error | undefined): Promise<ExecStream> {
  // imp-runtime's buildNotAwakeError, with no cold boots on record; the real
  // service boots a stopped imp for an exec, so there it is any typed refusal
  if (outcome === undefined) {
    const refused = buildInvalidStateError('stopped', ['running'], 'attach without a wake to');

    return Promise.reject(
      new ORPCError('INVALID_STATE', {
        status: refused.status,
        message: refused.message,
        data: { ...refused.data, coldBoots: [] },
      }),
    );
  }

  return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
}
