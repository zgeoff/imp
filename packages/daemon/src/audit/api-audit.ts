import { ORPCError } from '@orpc/server';
import type { AuditActor } from '../auth/caller';
import { writeApiCall } from '../db/api-audit';
import type { ImpDatabase } from '../db/open-database';
import { readErrorMessage } from '../read-error-message';

// namespaces whose input `name` is an imp's; a secret's or an image's is not
const IMP_NAMESPACES: ReadonlySet<string> = new Set([
  'imps',
  'checkpoints',
  'backups',
  'sessions',
  'grants',
]);

export interface AuditedCall {
  readonly procedure: string;
  readonly actor: AuditActor;
  readonly impName: string | null;
  readonly startedAt: number;

  // what the call resolved that its name does not show, set by its handler
  readonly detail?: string | null;
}

export interface ApiAudit {
  // writes the row without holding up the caller; a failed write is
  // logged. `failure` is what the call threw, null when it succeeded.
  readonly record: (call: AuditedCall, failure: unknown) => void;
}

interface ApiAuditDeps {
  readonly db: ImpDatabase;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function createApiAudit(deps: ApiAuditDeps): ApiAudit {
  return {
    record: (call, failure) => {
      void writeCall(deps, call, failure);
    },
  };
}

// The imp a call named, from its input, else from its result (`imps.create`
// with no name gets one). Only the name: the input itself is never kept.
export function readImpName(procedure: string, input: unknown, output: unknown): string | null {
  const namespace = procedure.split('.')[0] ?? '';

  // a template reads its source imp's disk
  if (procedure === 'images.add') {
    return readField(input, 'imp');
  }

  if (!IMP_NAMESPACES.has(namespace)) {
    return null;
  }

  return readField(input, 'name') ?? readField(output, 'name');
}

function readField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }

  const field: unknown = Reflect.get(value, key);

  return typeof field === 'string' ? field : null;
}

// `ok` for a call that succeeded, else the error code the caller got
function readOutcome(failure: unknown): string {
  if (failure === null) {
    return 'ok';
  }

  return failure instanceof ORPCError ? String(failure.code) : 'INTERNAL_SERVER_ERROR';
}

// Opens a session, an exec or an ssh channel, and audits the open: its
// outcome, not how long the session then runs.
export async function withAuditedOpen<T>(
  audit: ApiAudit,
  call: AuditedCall,
  open: () => Promise<T>,
): Promise<T> {
  try {
    const opened = await open();

    audit.record(call, null);

    return opened;
  } catch (error) {
    audit.record(call, error);
    throw error;
  }
}

async function writeCall(deps: ApiAuditDeps, call: AuditedCall, failure: unknown): Promise<void> {
  const now = deps.now();

  try {
    await writeApiCall(deps.db, {
      at: new Date(now),
      procedure: call.procedure,
      actor: call.actor.kind,
      actorName: call.actor.name,
      impName: call.impName,
      outcome: readOutcome(failure),
      durationMs: Math.max(0, Math.round(now - call.startedAt)),
      detail: call.detail ?? null,
    });
  } catch (error) {
    deps.log(`impd: audit: ${call.procedure}: ${readErrorMessage(error)}`);
  }
}
