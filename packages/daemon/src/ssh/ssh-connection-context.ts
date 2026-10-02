import type { AgentFeature } from '../agent-client/agent-outdated';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import type { AuditActor } from '../auth/caller';
import type { ImpRecord } from '../db/imps';
import type { ImpRuntime } from '../imps/imp-runtime';
import type { AgentForwarding } from './agent-forwarding';

// What the gateway needs from impd.
export interface SshBackend extends Pick<
  ImpRuntime,
  'requireRunning' | 'tracker' | 'openDial' | 'openListener' | 'openAccept' | 'recordActivity'
> {
  readonly findImp: (name: string) => Promise<ImpRecord | undefined>;

  // the runtime's, with who logged in, for the audit
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature: AgentFeature | undefined,
    actor: AuditActor,
  ) => Promise<ExecStream>;
}

// One authenticated connection, as its channels see it.
export interface SshConnectionContext {
  readonly impName: string;

  // who logged in: the token a key is bound to, or `key <comment>` for a
  // key in authorized_keys
  readonly actor: AuditActor;
  readonly backend: SshBackend;

  // settles once the imp is awake, or rejects with why it could not wake; a
  // channel waits for it, so a failed wake reaches the client as an error
  // instead of a refused login
  readonly awake: Promise<void>;

  // SSH_CONNECTION and SSH_CLIENT, as sshd sets them
  readonly sshEnv: readonly string[];

  // the connection's forwarded ssh-agent, for sessions that asked for it
  readonly agent: AgentForwarding;
  readonly log: (message: string) => void;
}
