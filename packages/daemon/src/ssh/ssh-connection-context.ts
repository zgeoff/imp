import type { ImpRecord } from '../db/imps';
import type { ImpRuntime } from '../imps/imp-runtime';

// What the gateway needs from impd.
export interface SshBackend extends Pick<
  ImpRuntime,
  'requireRunning' | 'tracker' | 'openExec' | 'openDial' | 'recordActivity'
> {
  readonly findImp: (name: string) => Promise<ImpRecord | undefined>;
}

// One authenticated connection, as its channels see it.
export interface SshConnectionContext {
  readonly impName: string;
  readonly backend: SshBackend;

  // settles once the imp is awake, or rejects with why it could not wake; a
  // channel waits for it, so a failed wake reaches the client as an error
  // instead of a refused login
  readonly awake: Promise<void>;

  // SSH_CONNECTION and SSH_CLIENT, as sshd sets them
  readonly sshEnv: readonly string[];
  readonly log: (message: string) => void;
}
