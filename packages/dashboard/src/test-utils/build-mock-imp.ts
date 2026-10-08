import type { Imp } from '@imp/api';
import { ImpRowSchema } from '../mocks/db/imp-collection';

// An imp as impd lists it, with the defaults of the mock impd's imps: a
// running imp with every optional field left out
export function buildMockImp(overrides: Partial<Imp> = {}): Imp {
  return ImpRowSchema.parse(overrides);
}
