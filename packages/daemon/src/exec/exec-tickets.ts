import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiActor } from '@imp/api';

// Single-use `/exec` tickets: a browser WebSocket cannot send the bearer
// header, and the token must never land in a URL (docs/architecture/daemon.md).

const TICKET_TTL_MS = 30_000;

// a client asking in a loop evicts its own oldest tickets instead of growing
// the map
const MAX_LIVE_TICKETS = 256;

interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

// the imp a ticket opens, and who asked for it, for the audit log
interface TicketHolder {
  readonly name: string;
  readonly actor: ApiActor;
}

export interface ExecTickets {
  readonly issue: (name: string, actor: ApiActor) => IssuedTicket;

  // what the ticket was issued for, or null when it is unknown, expired or
  // used; a ticket redeems once
  readonly redeem: (ticket: string) => TicketHolder | null;
}

interface LiveTicket {
  readonly secret: Buffer;
  readonly holder: TicketHolder;
  readonly expiresAt: number;
}

// A ticket is `<id>.<secret>`: the id finds the entry, and the secret is
// compared in constant time, so a map lookup's timing gives nothing away.
export function createExecTickets(now: () => number): ExecTickets {
  const live = new Map<string, LiveTicket>();

  const removeExpired = (at: number): void => {
    for (const [id, entry] of live) {
      if (entry.expiresAt <= at) {
        live.delete(id);
      }
    }
  };

  return {
    issue: (name, actor) => {
      const at = now();

      removeExpired(at);

      // a Map iterates in insertion order: the first key is the oldest
      while (live.size >= MAX_LIVE_TICKETS) {
        const [oldest] = live.keys();

        if (oldest === undefined) {
          break;
        }

        live.delete(oldest);
      }

      const id = randomBytes(12).toString('base64url');
      const secret = randomBytes(32);
      const expiresAt = at + TICKET_TTL_MS;

      live.set(id, { secret, holder: { name, actor }, expiresAt });

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

      return entry.holder;
    },
  };
}
