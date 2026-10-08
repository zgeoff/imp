import { expect, test } from 'bun:test';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createImage } from './images';
import { createImp, removeImp } from './imps';
import {
  listNetworkMembers,
  listNetworks,
  removeMember,
  removeNetwork,
  writeMember,
  writeNetwork,
} from './networks';

async function setupNetwork() {
  const ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const network = await writeNetwork(ctx.db, 'lab');

  if (network === null) {
    throw new Error('expected a new network');
  }

  const createMember = (name: string, slot: number) =>
    createImp(ctx.db, {
      name,
      imageId: image.id,
      vcpus: 1,
      memoryMib: 512,
      slot,
      ip: `10.66.0.${String(slot * 4 + 2)}`,
      networkIds: [network.id],
    });

  return Object.assign(ctx, { network, createMember });
}

test('it refuses a second network by the same name', async () => {
  const ctx = await setupNetwork();
  const again = await writeNetwork(ctx.db, 'lab');

  expect(again).toBeNull();
});

test('an imp created on a network is a member from its insert', async () => {
  const ctx = await setupNetwork();

  await ctx.createMember('web', 0);
  await ctx.createMember('db', 1);

  const members = await listNetworkMembers(ctx.db);

  expect(
    members.map((member) => [member.network, member.name, member.slot, member.guestIp]),
  ).toEqual([
    ['lab', 'db', 1, '10.66.0.6'],
    ['lab', 'web', 0, '10.66.0.2'],
  ]);

  const networks = await listNetworks(ctx.db);

  expect(networks.map((network) => network.imps)).toEqual([['db', 'web']]);
});

test("a destroyed imp's memberships go with its row", async () => {
  const ctx = await setupNetwork();
  const web = await ctx.createMember('web', 0);

  await ctx.createMember('db', 1);

  await removeImp(ctx.db, web.id);

  const members = await listNetworkMembers(ctx.db);

  expect(members.map((member) => member.name)).toEqual(['db']);
});

test("a removed network's memberships go with it", async () => {
  const ctx = await setupNetwork();

  await ctx.createMember('web', 0);

  await removeNetwork(ctx.db, ctx.network.id);

  const members = await listNetworkMembers(ctx.db);

  expect(members).toEqual([]);
});

test('join and leave say whether they changed anything', async () => {
  const ctx = await setupNetwork();
  const web = await ctx.createMember('web', 0);

  const changes = [
    await writeMember(ctx.db, ctx.network.id, web.id),
    await removeMember(ctx.db, ctx.network.id, web.id),
    await removeMember(ctx.db, ctx.network.id, web.id),
    await writeMember(ctx.db, ctx.network.id, web.id),
  ];

  expect(changes).toEqual([false, true, false, true]);
});
