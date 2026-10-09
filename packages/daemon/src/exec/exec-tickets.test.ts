import { expect, test } from 'bun:test';
import { createRevocations } from '../auth/revocations';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { createExecTickets, isCallerLive } from './exec-tickets';

function setupTest() {
  const clock = { at: 1_000_000 };

  const removedTokenIds = new Set<string>();

  const tickets = createExecTickets({
    now: () => clock.at,
    isLive: (caller) => caller.tokenId === null || !removedTokenIds.has(caller.tokenId),
  });

  return { clock, removedTokenIds, tickets };
}

test('#issue keeps the caller that asked for the ticket', () => {
  const ctx = setupTest();
  const caller = buildMockCaller({ kind: 'dashboard' });
  const issued = ctx.tickets.issue('dev', caller);

  expect(ctx.tickets.redeem(issued.ticket)).toStrictEqual({ name: 'dev', caller });
});

test('#issue sets the ticket to expire 30 seconds after it is issued', () => {
  const ctx = setupTest();
  const issued = ctx.tickets.issue('dev', buildMockCaller());

  expect(issued.expiresAt).toStrictEqual(new Date(1_030_000));
});

test('#redeem opens a ticket only once', () => {
  const ctx = setupTest();
  const issued = ctx.tickets.issue('dev', buildMockCaller());

  ctx.tickets.redeem(issued.ticket);

  expect(ctx.tickets.redeem(issued.ticket)).toBeNull();
});

test('#redeem refuses a ticket 30 seconds after it was issued', () => {
  const ctx = setupTest();
  const issued = ctx.tickets.issue('dev', buildMockCaller());

  ctx.clock.at += 30_000;

  expect(ctx.tickets.redeem(issued.ticket)).toBeNull();
});

test('#redeem opens a ticket just before it expires', () => {
  const ctx = setupTest();
  const caller = buildMockCaller();
  const issued = ctx.tickets.issue('dev', caller);

  ctx.clock.at += 29_999;

  expect(ctx.tickets.redeem(issued.ticket)).toStrictEqual({ name: 'dev', caller });
});

test('#redeem refuses a ticket with the right id and the wrong secret', () => {
  const ctx = setupTest();
  const issued = ctx.tickets.issue('dev', buildMockCaller());
  const id = issued.ticket.slice(0, issued.ticket.indexOf('.'));

  expect(ctx.tickets.redeem(`${id}.${Buffer.alloc(32).toString('base64url')}`)).toBeNull();
});

test('#redeem refuses a ticket with no secret part', () => {
  const ctx = setupTest();

  ctx.tickets.issue('dev', buildMockCaller());

  expect(ctx.tickets.redeem('garbage')).toBeNull();
});

test('#redeem refuses a ticket with an extra part', () => {
  const ctx = setupTest();
  const issued = ctx.tickets.issue('dev', buildMockCaller());

  expect(ctx.tickets.redeem(`${issued.ticket}.extra`)).toBeNull();
});

test('#redeem leaves the real ticket usable after a wrong guess', () => {
  const ctx = setupTest();
  const caller = buildMockCaller();
  const issued = ctx.tickets.issue('dev', caller);
  const id = issued.ticket.slice(0, issued.ticket.indexOf('.'));

  ctx.tickets.redeem(`${id}.${Buffer.alloc(32).toString('base64url')}`);

  expect(ctx.tickets.redeem(issued.ticket)).toStrictEqual({ name: 'dev', caller });
});

test("#issue evicts a caller's own oldest ticket at its cap of 32", () => {
  const ctx = setupTest();
  const caller = buildMockCaller();
  const first = ctx.tickets.issue('first', caller);

  for (let index = 0; index < 32; index++) {
    ctx.tickets.issue(`imp-${String(index)}`, caller);
  }

  expect(ctx.tickets.redeem(first.ticket)).toBeNull();
});

test("#issue keeps a caller's 32 newest tickets at its cap", () => {
  const ctx = setupTest();
  const caller = buildMockCaller();

  ctx.tickets.issue('first', caller);

  const issued = Array.from({ length: 32 }, (_, index) =>
    ctx.tickets.issue(`imp-${String(index)}`, caller),
  );

  expect(issued.map((ticket) => ctx.tickets.redeem(ticket.ticket)?.name)).toStrictEqual(
    Array.from({ length: 32 }, (_, index) => `imp-${String(index)}`),
  );
});

test("#issue never evicts another caller's ticket when one caller reaches its cap", () => {
  const ctx = setupTest();
  const other = buildMockCaller({ kind: 'dashboard' });
  const kept = ctx.tickets.issue('other', other);
  const caller = buildMockCaller();

  for (let index = 0; index < 33; index++) {
    ctx.tickets.issue(`imp-${String(index)}`, caller);
  }

  expect(ctx.tickets.redeem(kept.ticket)).toStrictEqual({ name: 'other', caller: other });
});

test('#issue evicts the oldest ticket of any caller past 1024 live tickets', () => {
  const ctx = setupTest();
  const first = ctx.tickets.issue('first', buildMockCaller());

  for (let index = 0; index < 1024; index++) {
    ctx.tickets.issue(`imp-${String(index)}`, buildMockCaller());
  }

  expect(ctx.tickets.redeem(first.ticket)).toBeNull();
});

test('#redeem refuses a ticket whose token was removed', () => {
  const ctx = setupTest();
  const caller = buildMockCaller();
  const issued = ctx.tickets.issue('dev', caller);

  ctx.removedTokenIds.add(caller.tokenId ?? '');

  expect(ctx.tickets.redeem(issued.ticket)).toBeNull();
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
