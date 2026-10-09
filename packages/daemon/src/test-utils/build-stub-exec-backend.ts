import type { AgentFeature } from '../agent-client/agent-outdated';
import type { AgentAttachRequest, AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
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

// The imp service behind an `/exec` socket: `opens` records each open, which
// answers with the given stream or error, or rejects as a stopped imp does.
// `activity` records each imp a session reports once its stream ends.
export function buildStubExecBackend(options: StubExecBackendOptions = {}) {
  const opens: StubOpen[] = [];
  const activity: string[] = [];

  const backend: ExecBackend = {
    openExec: (name, request, feature) => {
      opens.push({ kind: 'exec', name, request, feature });

      return openOutcome(options.exec, name);
    },
    openAttach: (name, request) => {
      opens.push({ kind: 'attach', name, request });

      return openOutcome(options.attach, name);
    },
    recordActivity: (name) => {
      activity.push(name);

      return Promise.resolve();
    },
  };

  return { backend, opens, activity };
}

function openOutcome(outcome: ExecStream | Error | undefined, name: string): Promise<ExecStream> {
  if (outcome === undefined) {
    return Promise.reject(new Error(`no stream for imp ${name}`));
  }

  return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
}
