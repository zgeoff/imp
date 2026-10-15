import type { IMP_ERRORS } from '@impz/api';
import type { ReadonlyFields } from '@impz/shared';
import type * as z from 'zod';
import { ExecError } from './exec-error';

// INVALID_STATE's data; coldBoots is set for an attach with wake: false to
// an imp that is not running, unless it is still being created
export type InvalidStateData = ReadonlyFields<z.infer<typeof IMP_ERRORS.INVALID_STATE.data>>;

// The imp is not in a state that allows this.
export class InvalidStateError extends ExecError {
  declare readonly data: InvalidStateData;

  constructor(message: string, data: Readonly<InvalidStateData>) {
    super('INVALID_STATE', message, { data });

    this.name = 'InvalidStateError';
  }
}
