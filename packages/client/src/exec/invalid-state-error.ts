import type { ColdBoot, ImpState } from '@imp/api';
import { ExecError } from './exec-error';

// INVALID_STATE's data; coldBoots is set for an attach with wake: false to
// an imp that is not running, unless it is still being created
export interface InvalidStateData {
  readonly state: ImpState;
  readonly allowed: readonly ImpState[];
  readonly coldBoots?: readonly ColdBoot[] | undefined;
}

// The imp is not in a state that allows this.
export class InvalidStateError extends ExecError {
  declare readonly data: InvalidStateData;

  constructor(message: string, data: Readonly<InvalidStateData>) {
    super('INVALID_STATE', message, { data });

    this.name = 'InvalidStateError';
  }
}
