import { expect, test } from 'bun:test';
import { createRevocations } from '../auth/revocations';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { createExecTickets, isCallerLive } from './exec-tickets';

test('#issue keeps the caller that asked for the ticket', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const caller = buildMockCaller({ kind: 'dashboard' });
  const issued = tickets.issue('dev', caller);

  expect(tickets.redeem(issued.ticket)).toStrictEqual({ name: 'dev', caller });
});

test('#issue sets the ticket to expire 30 seconds after it is issued', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const issued = tickets.issue('dev', buildMockCaller());

  expect(issued.expiresAt).toStrictEqual(new Date(1_030_000));
});

test('#redeem opens a ticket only once', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const issued = tickets.issue('dev', buildMockCaller());

  tickets.redeem(issued.ticket);

  expect(tickets.redeem(issued.ticket)).toBeNull();
});

test('#redeem refuses a ticket 30 seconds after it was issued', () => {
  const clock = { at: 1_000_000 };
  const tickets = createExecTickets({ now: () => clock.at, isLive: () => true });
  const issued = tickets.issue('dev', buildMockCaller());

  clock.at = 1_030_000;

  expect(tickets.redeem(issued.ticket)).toBeNull();
});

test('#redeem opens a ticket just before it expires', () => {
  const clock = { at: 1_000_000 };
  const tickets = createExecTickets({ now: () => clock.at, isLive: () => true });
  const caller = buildMockCaller();
  const issued = tickets.issue('dev', caller);

  clock.at = 1_029_999;

  expect(tickets.redeem(issued.ticket)).toStrictEqual({ name: 'dev', caller });
});

test('#redeem refuses a ticket with the right id and the wrong secret', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const issued = tickets.issue('dev', buildMockCaller());
  const id = issued.ticket.slice(0, issued.ticket.indexOf('.'));

  expect(tickets.redeem(`${id}.${Buffer.alloc(32).toString('base64url')}`)).toBeNull();
});

test('#redeem refuses a ticket with no secret part', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });

  tickets.issue('dev', buildMockCaller());

  expect(tickets.redeem('garbage')).toBeNull();
});

test('#redeem refuses a ticket with an extra part', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const issued = tickets.issue('dev', buildMockCaller());

  expect(tickets.redeem(`${issued.ticket}.extra`)).toBeNull();
});

test('#redeem leaves the real ticket usable after a wrong guess', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const caller = buildMockCaller();
  const issued = tickets.issue('dev', caller);
  const id = issued.ticket.slice(0, issued.ticket.indexOf('.'));

  tickets.redeem(`${id}.${Buffer.alloc(32).toString('base64url')}`);

  expect(tickets.redeem(issued.ticket)).toStrictEqual({ name: 'dev', caller });
});

test("#issue evicts a caller's own oldest ticket at its cap of 32", () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const caller = buildMockCaller();
  const first = tickets.issue('first', caller);

  for (let index = 0; index < 32; index++) {
    tickets.issue(`imp-${String(index)}`, caller);
  }

  expect(tickets.redeem(first.ticket)).toBeNull();
});

test("#issue keeps a caller's 32 newest tickets at its cap", () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const caller = buildMockCaller();

  tickets.issue('first', caller);

  const issued = Array.from({ length: 32 }, (_, index) =>
    tickets.issue(`imp-${String(index)}`, caller),
  );

  expect(issued.map((ticket) => tickets.redeem(ticket.ticket)?.name)).toStrictEqual(
    Array.from({ length: 32 }, (_, index) => `imp-${String(index)}`),
  );
});

test("#issue never evicts another caller's ticket when one caller reaches its cap", () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const other = buildMockCaller({ kind: 'dashboard' });
  const kept = tickets.issue('other', other);
  const caller = buildMockCaller();

  for (let index = 0; index < 33; index++) {
    tickets.issue(`imp-${String(index)}`, caller);
  }

  expect(tickets.redeem(kept.ticket)).toStrictEqual({ name: 'other', caller: other });
});

test('#issue evicts the oldest ticket of any caller past 1024 live tickets', () => {
  const tickets = createExecTickets({ now: () => 1_000_000, isLive: () => true });
  const first = tickets.issue('first', buildMockCaller());

  for (let index = 0; index < 1024; index++) {
    tickets.issue(`imp-${String(index)}`, buildMockCaller());
  }

  expect(tickets.redeem(first.ticket)).toBeNull();
});

test('#redeem refuses a ticket whose token was removed', () => {
  const removedTokenIds = new Set<string>();

  const tickets = createExecTickets({
    now: () => 1_000_000,
    isLive: (caller) => caller.tokenId === null || !removedTokenIds.has(caller.tokenId),
  });

  const caller = buildMockCaller({ tokenId: 'token-a' });
  const issued = tickets.issue('dev', caller);

  removedTokenIds.add('token-a');

  expect(tickets.redeem(issued.ticket)).toBeNull();
});

test('#isCallerLive refuses an OAuth grant once it is revoked', () => {
  const revocations = createRevocations();
  const grant = buildMockCaller({ kind: 'oauth', grantId: 'grant-a' });

  revocations.revoke('grant-a');

  expect(isCallerLive({ findById: () => grant }, revocations, grant)).toBe(false);
});

test('#isCallerLive keeps a sibling OAuth grant live when another grant is revoked', () => {
  const revocations = createRevocations();
  const sibling = buildMockCaller({ kind: 'oauth', grantId: 'grant-b' });

  revocations.revoke('grant-a');

  expect(isCallerLive({ findById: () => sibling }, revocations, sibling)).toBe(true);
});

test('#isCallerLive refuses an OAuth grant once its token is gone', () => {
  const revocations = createRevocations();
  const grant = buildMockCaller({ kind: 'oauth', grantId: 'grant-b' });

  expect(isCallerLive({ findById: () => null }, revocations, grant)).toBe(false);
});

test('#isCallerLive keeps a caller with no token and no grant live', () => {
  const revocations = createRevocations();
  const caller = buildMockCaller({ kind: 'dashboard', tokenId: null });

  expect(isCallerLive({ findById: () => null }, revocations, caller)).toBe(true);
});
