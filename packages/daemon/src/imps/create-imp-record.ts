import { buildConflictError } from '../api-errors';
import type { ImageRecord } from '../db/images';
import { allocateSlot, createImp, findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { countSlots } from '../net/addressing';
import type { ImpContext } from './imp-context';

const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

interface NewImpInput {
  readonly name?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;
  readonly httpPort?: number | undefined;
}

// A `creating` record with id `id` and a free slot, under the requested name or a free
// `imp-xxxx`.
export async function createImpRecord(
  context: ImpContext,
  id: string,
  input: NewImpInput,
  image: ImageRecord,
): Promise<ImpRecord> {
  const name = await resolveImpName(context, input.name);

  try {
    return await context.db.transaction().execute(async (trx) => {
      const slot = await allocateSlot(trx, countSlots(context.config.subnet));

      return createImp(trx, {
        id,
        name,
        imageId: image.id,
        vcpus: input.vcpus ?? context.config.defaultVcpus,
        memoryMib: input.memoryMib ?? context.config.defaultMemoryMib,
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
        slot,
        ip: context.findAddress(slot).guestIp,
      });
    });
  } catch (error) {
    // slot and ip come from the same transaction: only the name can clash
    if (isUniqueViolation(error)) {
      throw buildConflictError('imp', name);
    }

    throw error;
  }
}

// the requested name, else a free `imp-xxxx`
async function resolveImpName(context: ImpContext, requested: string | undefined): Promise<string> {
  if (requested !== undefined) {
    return requested;
  }

  for (;;) {
    const picks = Array.from({ length: 4 }, () => Math.random() * NAME_ALPHABET.length);
    const suffix = picks.map((pick) => NAME_ALPHABET[Math.floor(pick)]).join('');
    const name = `imp-${suffix}`;

    const taken = await findImpByName(context.db, name);

    if (taken === undefined) {
      return name;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
