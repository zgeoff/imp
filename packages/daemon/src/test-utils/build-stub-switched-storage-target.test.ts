import { expect, test } from 'bun:test';
import { MOVE_PATHS } from '../moves/move-header';
import { buildTicketHeader } from '../moves/move-tickets';
import { SOURCE_PEER, TARGET_URL, setupMoveHosts } from '../moves/test-moves';
import { buildStubSwitchedStorageTarget } from './build-stub-switched-storage-target';

// a real target to answer the stub's forwards
function setupTest() {
  return setupMoveHosts();
}

test('it names the given storage in the real target offer reply', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1 });

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.offer}`, {
    method: 'POST',
    headers: { ...buildTicketHeader(ticket.ticket), 'content-type': 'application/json' },
    body: JSON.stringify({ imageDigest: 'sha256:ubuntu' }),
  });

  const response = await buildStubSwitchedStorageTarget('zfs')(
    request,
    (replacement) => ctx.targetApp.moves.handle(replacement ?? request, SOURCE_PEER),
    ctx,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(200);

  expect(body).toStrictEqual({
    needsImage: true,
    needsSystemDrive: false,
    storage: 'zfs',
    keepsMaxMemory: true,
    keepsLeases: true,
    keepsPublicEgress: true,
  });
});

test('it passes the answer of another route through unchanged', async () => {
  const ctx = await setupTest();
  const ticket = await ctx.targetApp.client.moves.receive({ name: 'dev', bytes: 1 });

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.commit}`, {
    method: 'POST',
    headers: buildTicketHeader(ticket.ticket),
  });

  const response = await buildStubSwitchedStorageTarget('xfs')(
    request,
    (replacement) => ctx.targetApp.moves.handle(replacement ?? request, SOURCE_PEER),
    ctx,
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(409);

  expect(body).toStrictEqual({
    error: 'nothing to commit: no receipt for this ticket',
  });
});
