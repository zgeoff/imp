import { expect, onTestFinished, test } from 'bun:test';
import { createQueryGate } from './build-query-gate';
import { setupTestDatabase } from './create-test-database';

test('it holds nothing before it is armed', async () => {
  await using testDatabase = await setupTestDatabase();

  const gate = createQueryGate('images');

  const rows = await testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .execute();

  expect({ rows, reached: Bun.peek.status(gate.reached) }).toStrictEqual({
    rows: [{ name: 'base' }],
    reached: 'pending',
  });
});

test('it holds the first select naming it once armed', async () => {
  await using testDatabase = await setupTestDatabase();

  const gate = createQueryGate('images');

  onTestFinished(() => {
    gate.release();
  });

  gate.arm();

  const held = testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .execute();

  await gate.reached;

  expect(Bun.peek.status(held)).toBe('pending');
});

test('it lets the held select finish with its rows after release', async () => {
  await using testDatabase = await setupTestDatabase();

  const gate = createQueryGate('images');

  gate.arm();

  const held = testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .execute();

  await gate.reached;

  gate.release();

  expect(held).resolves.toStrictEqual([{ name: 'base' }]);
});

test('it holds only the first matching select', async () => {
  await using testDatabase = await setupTestDatabase();

  const gate = createQueryGate('images');
  const gated = testDatabase.db.withPlugin(gate.plugin);

  onTestFinished(() => {
    gate.release();
  });

  gate.arm();

  const held = gated.selectFrom('images').select('name').execute();

  await gate.reached;

  const rows = await gated.selectFrom('images').select('ref').execute();

  expect({ rows, held: Bun.peek.status(held) }).toStrictEqual({
    rows: [{ ref: 'imp/base:latest' }],
    held: 'pending',
  });
});

test('it ignores a select that does not name it', async () => {
  await using testDatabase = await setupTestDatabase();

  const gate = createQueryGate('imps');

  gate.arm();

  const rows = await testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .execute();

  expect({ rows, reached: Bun.peek.status(gate.reached) }).toStrictEqual({
    rows: [{ name: 'base' }],
    reached: 'pending',
  });
});

test('it stays armed past a select that does not name it', async () => {
  await using testDatabase = await setupTestDatabase();

  const gate = createQueryGate('images');
  const gated = testDatabase.db.withPlugin(gate.plugin);

  onTestFinished(() => {
    gate.release();
  });

  gate.arm();

  await gated.selectFrom('imps').select('name').execute();

  const held = gated.selectFrom('images').select('name').execute();

  await gate.reached;

  expect(Bun.peek.status(held)).toBe('pending');
});
