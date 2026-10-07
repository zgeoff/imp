import { expect, onTestFinished, test } from 'bun:test';
import { createImage } from '../db/images';
import { buildQueryGate } from './build-query-gate';
import { createTestDatabase } from './create-test-database';

test('it holds nothing before it is armed', async () => {
  await using testDatabase = await createTestDatabase();

  await createImage(testDatabase.db, {
    name: 'ubuntu',
    ref: 'imp/ubuntu:24.04',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const gate = buildQueryGate('images');

  const rows = await testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .where('name', '=', 'ubuntu')
    .execute();

  expect({ rows, reached: Bun.peek.status(gate.reached) }).toStrictEqual({
    rows: [{ name: 'ubuntu' }],
    reached: 'pending',
  });
});

test('it holds the first select naming it once armed', async () => {
  await using testDatabase = await createTestDatabase();

  const gate = buildQueryGate('images');

  onTestFinished(() => {
    gate.release();
  });

  gate.arm();

  const held = testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .where('name', '=', 'ubuntu')
    .execute();

  await gate.reached;

  expect(Bun.peek.status(held)).toBe('pending');
});

test('it lets the held select finish with its rows after release', async () => {
  await using testDatabase = await createTestDatabase();

  await createImage(testDatabase.db, {
    name: 'ubuntu',
    ref: 'imp/ubuntu:24.04',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const gate = buildQueryGate('images');

  gate.arm();

  const held = testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .where('name', '=', 'ubuntu')
    .execute();

  await gate.reached;

  gate.release();

  expect(held).resolves.toStrictEqual([{ name: 'ubuntu' }]);
});

test('it holds only the first matching select', async () => {
  await using testDatabase = await createTestDatabase();

  await createImage(testDatabase.db, {
    name: 'ubuntu',
    ref: 'imp/ubuntu:24.04',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const gate = buildQueryGate('images');
  const gated = testDatabase.db.withPlugin(gate.plugin);

  onTestFinished(() => {
    gate.release();
  });

  gate.arm();

  const held = gated.selectFrom('images').select('name').execute();

  await gate.reached;

  const rows = await gated
    .selectFrom('images')
    .select('ref')
    .where('name', '=', 'ubuntu')
    .execute();

  expect({ rows, held: Bun.peek.status(held) }).toStrictEqual({
    rows: [{ ref: 'imp/ubuntu:24.04' }],
    held: 'pending',
  });
});

test('it ignores a select that does not name it', async () => {
  await using testDatabase = await createTestDatabase();

  await createImage(testDatabase.db, {
    name: 'ubuntu',
    ref: 'imp/ubuntu:24.04',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const gate = buildQueryGate('imps');

  gate.arm();

  const rows = await testDatabase.db
    .withPlugin(gate.plugin)
    .selectFrom('images')
    .select('name')
    .where('name', '=', 'ubuntu')
    .execute();

  expect({ rows, reached: Bun.peek.status(gate.reached) }).toStrictEqual({
    rows: [{ name: 'ubuntu' }],
    reached: 'pending',
  });
});

test('it stays armed past a select that does not name it', async () => {
  await using testDatabase = await createTestDatabase();

  const gate = buildQueryGate('images');
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
