import type { EgressPolicy } from '@imp/api';
import { buildConflictError } from '../api-errors';
import type { ImageRecord } from '../db/images';
import { createImpInFreeSlot, findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { countSlots } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { resolveCpuSettings } from './cpu-limit';
import type { ImpContext } from './imp-context';

const CREATE_TRIES = 3;
const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

interface NewImpInput {
  readonly name?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;
  readonly httpPort?: number | undefined;
  readonly diskBytes?: number | undefined;
  readonly policy?: EgressPolicy | undefined;
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;
  readonly isIdentityResetPending?: boolean;
  readonly networkIds?: readonly string[] | undefined;
  readonly moveState?: 'receiving' | undefined;

  // a warm move's: this slot, or a SlotTakenError
  readonly slot?: number | undefined;
}

// A `creating` record with id `id` and a free slot, under the requested name or a free
// `imp-xxxx`.
export async function createImpRecord(
  context: ImpContext,
  id: string,
  input: NewImpInput,
  image: ImageRecord,
): Promise<ImpRecord> {
  const cpu = resolveCpuSettings(input, null, context.hostCpus);

  const name = await resolveImpName(context, input.name);

  const createRecord = () =>
    createImpInFreeSlot(
      context.db,
      {
        id,
        name,
        imageId: image.id,
        vcpus: input.vcpus ?? context.config.defaultVcpus,
        memoryMib: input.memoryMib ?? context.config.defaultMemoryMib,
        ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
        ...(input.policy !== undefined && { egress: input.policy }),
        ...(input.networkIds !== undefined && { networkIds: input.networkIds }),
        ...(input.diskBytes !== undefined && { diskBytes: input.diskBytes }),
        ...(input.moveState !== undefined && { moveState: input.moveState }),
        cpu,
        ...(input.isIdentityResetPending === true && { isIdentityResetPending: true }),
      },
      {
        count: countSlots(context.config.subnet),
        findIp: (slot) => context.findAddress(slot).guestIp,
        slot: input.slot,
        now: context.now,
      },
    );

  // slot, ip and jail uid come from one transaction, so only the name should
  // clash; a jail uid clash is a race to retry, not the caller's mistake
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createRecord();
    } catch (error) {
      if (isJailUidClash(error) && attempt < CREATE_TRIES) {
        continue;
      }

      if (isUniqueViolation(error) && !isJailUidClash(error)) {
        throw buildConflictError('imp', name);
      }

      throw error;
    }
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

function isJailUidClash(error: unknown): boolean {
  return isUniqueViolation(error) && readErrorMessage(error).includes('jail_uid');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
