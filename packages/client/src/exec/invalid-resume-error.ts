import type { InvalidResumeData } from '@imp/api';
import { ExecError } from './exec-error';

// A resume named an offset past the end of its generation: a client bug.
export class InvalidResumeError extends ExecError {
  declare readonly data: InvalidResumeData;

  constructor(message: string, data: InvalidResumeData) {
    super('INVALID_RESUME', message, { data });

    this.name = 'InvalidResumeError';
  }
}
