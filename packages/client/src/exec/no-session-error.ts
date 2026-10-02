import type { NoSessionData } from '@imp/api';
import { ExecError } from './exec-error';

// No process runs under the session name. data, from an agent with offsets,
// names this boot, the imp's cold boots and the generation that last ran
// under the name; an older agent sends none.
export class NoSessionError extends ExecError {
  declare readonly data: NoSessionData | undefined;

  constructor(message: string, data: NoSessionData | undefined) {
    super('NO_SESSION', message, { data });

    this.name = 'NoSessionError';
  }
}
