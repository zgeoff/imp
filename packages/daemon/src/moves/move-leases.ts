import type { ImpRecord } from '../db/imps';
import { listLeases, writeMovedLeases } from '../db/leases';
import type { ImpDatabase } from '../db/open-database';
import { MAX_LEASE_REMAINING_MS, MAX_MOVED_LEASES, MovedLeaseOwnerSchema } from './move-header';
import type { MoveHeader, MovedLease } from './move-header';
import { OfferRefusalError } from './offer-refusal-error';

interface MoveLeasesDeps {
  readonly db: ImpDatabase;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// The imp's live leases, each with the time it has left now: the target
// ends it that long after it reads the header. The mark keeps every lease
// call off the imp until the commit, so the rows here stay as sent.
export async function buildMovedLeases(
  deps: MoveLeasesDeps,
  imp: ImpRecord,
): Promise<MoveHeader['imp']['leases']> {
  const at = deps.now();

  const leases = await listLeases(deps.db, at, [imp.id]);

  return leases.map((lease) => {
    const remainingMs = lease.until === null ? null : lease.until.getTime() - at;

    // a hold past what a header carries ends at the cap on the target
    if (remainingMs !== null && remainingMs > MAX_LEASE_REMAINING_MS) {
      deps.log(
        `impd: move: ${imp.name}: lease ${lease.principal} ${lease.label} ends past 100 years; it moves with 100 years left`,
      );
    }

    return {
      principal: lease.principal,
      label: lease.label,
      display: lease.display,
      remainingMs: remainingMs === null ? null : Math.min(remainingMs, MAX_LEASE_REMAINING_MS),
      createdAt: lease.createdAt,
    };
  });
}

// Any live lease, a hold too, goes only to a target that keeps leases,
// and only as many as a header carries
export async function requireLeasesKept(
  deps: Pick<MoveLeasesDeps, 'db' | 'now'>,
  imp: ImpRecord,
  keepsLeases: boolean,
): Promise<void> {
  const leases = await listLeases(deps.db, deps.now(), [imp.id]);

  if (leases.length > 0 && !keepsLeases) {
    throw new OfferRefusalError(
      `the target's impd predates moving leases and would drop the imp's ${String(leases.length)} lease(s); upgrade it, or release them first`,
    );
  }

  if (leases.length > MAX_MOVED_LEASES) {
    throw new OfferRefusalError(
      `the imp has ${String(leases.length)} leases, more than a move carries (${String(MAX_MOVED_LEASES)}); release some first`,
    );
  }

  // the target would refuse the header after the stream started
  const unfit = leases.find((lease) => !MovedLeaseOwnerSchema.safeParse(lease).success);

  if (unfit !== undefined) {
    throw new OfferRefusalError(
      `the imp's lease ${unfit.label} of ${unfit.principal.slice(0, 64)} has an owner or label a move cannot carry (at most 256 characters); release it first`,
    );
  }
}

// The leases as of the header, less any that ended while the disk came.
// An older source sends none: the imp arrives unleased.
export async function writeReceivedLeases(
  deps: MoveLeasesDeps,
  header: MoveHeader,
  headerAt: number,
): Promise<void> {
  if (header.imp.leases === undefined) {
    deps.log(
      `impd: move: ${header.imp.name}: the source's impd predates moving leases; it arrives with none`,
    );

    return;
  }

  const now = deps.now();

  const live = header.imp.leases.flatMap((lease) => {
    const until = readMovedLeaseEnd(lease, headerAt);

    if (until !== null && until.getTime() <= now) {
      return [];
    }

    return [
      {
        principal: lease.principal,
        label: lease.label,
        display: lease.display,
        until,
        createdAt: lease.createdAt,
      },
    ];
  });

  await writeMovedLeases(deps.db, header.imp.id, live);
}

function readMovedLeaseEnd(lease: Readonly<MovedLease>, headerAt: number): Date | null {
  return lease.remainingMs === null ? null : new Date(headerAt + lease.remainingMs);
}
