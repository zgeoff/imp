import { expect, test } from 'bun:test';
import { buildMockMoveSendRow } from '../test-utils/build-mock-move-send-row';
import { createTestDatabase } from '../test-utils/create-test-database';
import { findMoveSend, removeMoveSend, updateMoveSend, writeMoveSend } from './move-sends';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#findMoveSend reads the row it wrote for the imp', async () => {
  const ctx = await setupTest();

  const row = buildMockMoveSendRow({ imp_id: 'imp-1' });

  await writeMoveSend(ctx.db, row);

  const found = await findMoveSend(ctx.db, 'imp-1');

  expect(found).toStrictEqual(row);
});

test('#findMoveSend finds nothing for an imp with no send', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  const found = await findMoveSend(ctx.db, 'imp-2');

  expect(found).toBeUndefined();
});

test('#updateMoveSend sets the fields it is given on the imp’s row', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  await updateMoveSend(ctx.db, 'imp-1', {
    peer_url: 'https://target.test:7071',
    ticket: 'ticket',
  });

  const found = await findMoveSend(ctx.db, 'imp-1');

  expect(found).toMatchObject({ peer_url: 'https://target.test:7071', ticket: 'ticket' });
});

test('#updateMoveSend never changes another imp’s row', async () => {
  const ctx = await setupTest();

  const other = buildMockMoveSendRow({ imp_id: 'imp-2' });

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));
  await writeMoveSend(ctx.db, other);
  await updateMoveSend(ctx.db, 'imp-1', { error: 'the target did not answer' });

  const found = await findMoveSend(ctx.db, 'imp-2');

  expect(found).toStrictEqual(other);
});

test('#removeMoveSend removes the imp’s row and keeps another imp’s', async () => {
  const ctx = await setupTest();

  const other = buildMockMoveSendRow({ imp_id: 'imp-2' });

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));
  await writeMoveSend(ctx.db, other);
  await removeMoveSend(ctx.db, 'imp-1');

  const rows = await ctx.db.selectFrom('move_sends').selectAll().execute();

  expect(rows).toStrictEqual([other]);
});
