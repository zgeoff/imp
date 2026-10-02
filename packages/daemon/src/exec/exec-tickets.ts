import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Caller } from '../auth/caller';

// Single-use `/exec` tickets: a browser WebSocket cannot send the bearer
// header, and the token must never land in a URL (docs/architecture/daemon.md).

const TICKET_TTL_MS = 30_000;

// a client asking in a loop evicts its own oldest tickets instead of growing
// the map, and never another caller's
const MAX_LIVE_TICKETS_PER_CALLER = 32;

// past this, the oldest ticket of any caller goes; only that many callers
// asking at once reach it
const MAX_LIVE_TICKETS = 1024;

interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

// the imp a ticket opens, and who asked for it: the socket runs as them
interface TicketHolder {
  readonly name: string;
  readonly caller: Caller;
}

export interface ExecTickets {
  readonly issue: (name: string, caller: Caller) => IssuedTicket;

  // what the ticket was issued for, or null when it is unknown, expired,
  // used, or its caller's token is gone; a ticket redeems once
  readonly redeem: (ticket: string) => TicketHolder | null;
}

interface LiveTicket {
  readonly secret: Buffer;
  readonly holder: TicketHolder;
  readonly owner: string;
  readonly expiresAt: number;
}

interface ExecTicketsDeps {
  readonly now: () => number;

  // false once the caller's token is removed
  readonly isLive: (caller: Readonly<Caller>) => boolean;
}

// A ticket is `<id>.<secret>`: the id finds the entry, and the secret is
// compared in constant time, so a map lookup's timing gives nothing away.
export function createExecTickets(deps: Readonly<ExecTicketsDeps>): ExecTickets {
  const now = deps.now;

  const live = new Map<string, LiveTicket>();

  // a Map iterates in insertion order: the first match is the oldest
  const removeOldest = (owner: string | null): void => {
    for (const [id, entry] of live) {
      if (owner === null || entry.owner === owner) {
        live.delete(id);

        return;
      }
    }
  };

  const countOwned = (owner: string): number =>
    [...live.values()].filter((entry) => entry.owner === owner).length;

  const removeExpired = (at: number): void => {
    for (const [id, entry] of live) {
      if (entry.expiresAt <= at) {
        live.delete(id);
      }
    }
  };

  return {
    issue: (name, caller) => {
      const at = now();
      const owner = readOwner(caller);

      removeExpired(at);

      if (countOwned(owner) >= MAX_LIVE_TICKETS_PER_CALLER) {
        removeOldest(owner);
      }

      if (live.size >= MAX_LIVE_TICKETS) {
        removeOldest(null);
      }

      const id = randomBytes(12).toString('base64url');
      const secret = randomBytes(32);
      const expiresAt = at + TICKET_TTL_MS;

      live.set(id, { secret, holder: { name, caller }, owner, expiresAt });

      return { ticket: `${id}.${secret.toString('base64url')}`, expiresAt: new Date(expiresAt) };
    },
    redeem: (ticket) => {
      removeExpired(now());

      const [id, secretText, ...rest] = ticket.split('.');

      if (id === undefined || secretText === undefined || rest.length > 0) {
        return null;
      }

      const entry = live.get(id);

      if (entry === undefined) {
        return null;
      }

      const given = Buffer.from(secretText, 'base64url');

      if (given.length !== entry.secret.length || !timingSafeEqual(given, entry.secret)) {
        return null;
      }

      live.delete(id);

      return deps.isLive(entry.holder.caller) ? entry.holder : null;
    },
  };
}

// whose tickets count together: a token's by its id, else the identity's
function readOwner(caller: Readonly<Caller>): string {
  return caller.tokenId === null ? `${caller.kind}:${caller.name}` : `token:${caller.tokenId}`;
}
