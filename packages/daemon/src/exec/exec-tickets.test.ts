import { expect, test } from 'bun:test';
import { createExecTickets } from './exec-tickets';

function setupTickets() {
  const clock = { at: 1_000_000 };
  const tickets = createExecTickets(() => clock.at);

  return { clock, tickets };
}

test('it redeems a ticket once, for the imp it was issued for', () => {
  const tickets = setupTickets().tickets;
  const issued = tickets.issue('dev');

  expect(tickets.redeem(issued.ticket)).toBe('dev');
  expect(tickets.redeem(issued.ticket)).toBeNull();
});

test('it expires a ticket after 30 seconds', () => {
  const ctx = setupTickets();
  const issued = ctx.tickets.issue('dev');

  expect(issued.expiresAt).toEqual(new Date(ctx.clock.at + 30_000));

  ctx.clock.at += 30_000;

  expect(ctx.tickets.redeem(issued.ticket)).toBeNull();
});

test('it rejects a ticket with the right id and the wrong secret', () => {
  const tickets = setupTickets().tickets;
  const issued = tickets.issue('dev');
  const [id] = issued.ticket.split('.');
  const forged = `${String(id)}.${Buffer.alloc(32).toString('base64url')}`;

  expect(tickets.redeem(forged)).toBeNull();
  expect(tickets.redeem('garbage')).toBeNull();
  expect(tickets.redeem(`${issued.ticket}.extra`)).toBeNull();

  // a failed guess leaves the real ticket usable
  expect(tickets.redeem(issued.ticket)).toBe('dev');
});

test('it evicts the oldest live ticket at the cap', () => {
  const tickets = setupTickets().tickets;
  const first = tickets.issue('first');
  const issued = Array.from({ length: 256 }, (_, index) => tickets.issue(`imp-${String(index)}`));

  expect(tickets.redeem(first.ticket)).toBeNull();

  expect(issued.map((ticket) => tickets.redeem(ticket.ticket))).toEqual(
    issued.map((_, index) => `imp-${String(index)}`),
  );
});
