import { expect, test } from 'bun:test';
import { createRevocations } from '../auth/revocations';
import { buildTestCaller } from '../auth/test-callers';
import { createExecTickets, isCallerLive } from './exec-tickets';

const TOKEN = buildTestCaller();
const DASHBOARD = buildTestCaller({ kind: 'dashboard', name: 'laptop', tokenId: 'other-id' });

function setupTickets() {
  const clock = { at: 1_000_000 };

  const removed = new Set<string>();

  const tickets = createExecTickets({
    now: () => clock.at,
    isLive: (caller) => caller.tokenId === null || !removed.has(caller.tokenId),
  });

  return { clock, removed, tickets };
}

test('a ticket keeps the caller that asked for it', () => {
  const tickets = setupTickets().tickets;
  const issued = tickets.issue('dev', DASHBOARD);

  expect(tickets.redeem(issued.ticket)).toEqual({ name: 'dev', caller: DASHBOARD });
});

test('it redeems a ticket once, for the imp it was issued for', () => {
  const tickets = setupTickets().tickets;
  const issued = tickets.issue('dev', TOKEN);

  expect(tickets.redeem(issued.ticket)).toEqual({ name: 'dev', caller: TOKEN });
  expect(tickets.redeem(issued.ticket)).toBeNull();
});

test('it expires a ticket after 30 seconds', () => {
  const ctx = setupTickets();
  const issued = ctx.tickets.issue('dev', TOKEN);

  expect(issued.expiresAt).toEqual(new Date(ctx.clock.at + 30_000));

  ctx.clock.at += 30_000;

  expect(ctx.tickets.redeem(issued.ticket)).toBeNull();
});

test('it rejects a ticket with the right id and the wrong secret', () => {
  const tickets = setupTickets().tickets;
  const issued = tickets.issue('dev', TOKEN);
  const [id] = issued.ticket.split('.');
  const forged = `${String(id)}.${Buffer.alloc(32).toString('base64url')}`;

  expect(tickets.redeem(forged)).toBeNull();
  expect(tickets.redeem('garbage')).toBeNull();
  expect(tickets.redeem(`${issued.ticket}.extra`)).toBeNull();

  // a failed guess leaves the real ticket usable
  expect(tickets.redeem(issued.ticket)).toEqual({ name: 'dev', caller: TOKEN });
});

test('a caller at its cap evicts its own oldest ticket, never another caller’s', () => {
  const tickets = setupTickets().tickets;
  const other = tickets.issue('other', DASHBOARD);
  const first = tickets.issue('first', TOKEN);

  const issued = Array.from({ length: 32 }, (_, index) =>
    tickets.issue(`imp-${String(index)}`, TOKEN),
  );

  expect(tickets.redeem(first.ticket)).toBeNull();
  expect(tickets.redeem(other.ticket)?.name).toBe('other');

  expect(issued.map((ticket) => tickets.redeem(ticket.ticket)?.name)).toEqual(
    issued.map((_, index) => `imp-${String(index)}`),
  );
});

test('a ticket whose token was removed opens nothing', () => {
  const ctx = setupTickets();
  const issued = ctx.tickets.issue('dev', TOKEN);

  ctx.removed.add(TOKEN.tokenId ?? '');

  expect(ctx.tickets.redeem(issued.ticket)).toBeNull();
});

test('an OAuth grant’s ticket opens nothing once the grant or its token goes', () => {
  const revocations = createRevocations();

  const tokens = new Set(['test-token-id']);

  const findById = (id: string) => (tokens.has(id) ? TOKEN : null);
  const grant = buildTestCaller({ kind: 'oauth', grantId: 'grant-a' });
  const sibling = buildTestCaller({ kind: 'oauth', grantId: 'grant-b' });

  const tickets = createExecTickets({
    now: () => 1_000_000,
    isLive: (caller) => isCallerLive({ findById }, revocations, caller),
  });

  const first = tickets.issue('dev', grant);
  const second = tickets.issue('dev', sibling);

  revocations.revoke('grant-a');

  expect(tickets.redeem(first.ticket)).toBeNull();
  expect(tickets.redeem(second.ticket)).toEqual({ name: 'dev', caller: sibling });

  const third = tickets.issue('dev', sibling);

  tokens.delete('test-token-id');

  expect(tickets.redeem(third.ticket)).toBeNull();
});
