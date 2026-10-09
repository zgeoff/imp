import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildMockNetworkRecord } from '../test-utils/build-mock-network-record';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createImage } from './images';
import { createImp, removeImp } from './imps';
import {
  findNetworkByName,
  listNetworkMembers,
  listNetworkNames,
  listNetworks,
  removeMember,
  removeNetwork,
  writeMember,
  writeNetwork,
  writeNetworkWithMembers,
} from './networks';

test('#writeNetwork returns the new network with no members', async () => {
  const ctx = await createTestDatabase();
  const network = await writeNetwork(ctx.db, 'lab');

  expect(network).toStrictEqual({
    id: expect.toBeString(),
    name: 'lab',
    createdAt: expect.toBeValidDate(),
    imps: [],
  });
});

test('#writeNetwork refuses a second network by the same name', async () => {
  const ctx = await createTestDatabase();

  await writeNetwork(ctx.db, 'lab');

  const again = await writeNetwork(ctx.db, 'lab');

  expect(again).toBeNull();
});

test('#listNetworkMembers lists an imp created on a network from its insert', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  const web = await createImp(
    ctx.db,
    buildMockNewImp({
      name: 'web',
      imageId: image.id,
      slot: 0,
      ip: '10.66.0.2',
      networkIds: [network.id],
    }),
  );

  const db = await createImp(
    ctx.db,
    buildMockNewImp({
      name: 'db',
      imageId: image.id,
      slot: 1,
      ip: '10.66.0.6',
      networkIds: [network.id],
    }),
  );

  const members = await listNetworkMembers(ctx.db);

  expect(members).toStrictEqual([
    { network: 'lab', impId: db.id, name: 'db', slot: 1, guestIp: '10.66.0.6' },
    { network: 'lab', impId: web.id, name: 'web', slot: 0, guestIp: '10.66.0.2' },
  ]);
});

test('#listNetworks lists each network with its members by name', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const lab = await writeNetwork(ctx.db, 'lab');
  const empty = await writeNetwork(ctx.db, 'empty');

  invariant(lab);
  invariant(empty);

  await createImp(
    ctx.db,
    buildMockNewImp({ name: 'web', imageId: image.id, slot: 0, networkIds: [lab.id] }),
  );

  await createImp(
    ctx.db,
    buildMockNewImp({
      name: 'db',
      imageId: image.id,
      slot: 1,
      ip: '10.66.0.3',
      networkIds: [lab.id],
    }),
  );

  const networks = await listNetworks(ctx.db);

  expect(networks).toStrictEqual([
    { ...empty, imps: [] },
    { ...lab, imps: ['db', 'web'] },
  ]);
});

test('#findNetworkByName finds the network of that name', async () => {
  const ctx = await createTestDatabase();

  await writeNetwork(ctx.db, 'other');

  const lab = await writeNetwork(ctx.db, 'lab');

  invariant(lab);

  const found = await findNetworkByName(ctx.db, 'lab');

  expect(found).toStrictEqual(lab);
});

test('#findNetworkByName finds nothing for a name no network has', async () => {
  const ctx = await createTestDatabase();

  await writeNetwork(ctx.db, 'lab');

  const found = await findNetworkByName(ctx.db, 'other');

  expect(found).toBeUndefined();
});

test('#listNetworkNames lists the names in order', async () => {
  const ctx = await createTestDatabase();

  await writeNetwork(ctx.db, 'lab');
  await writeNetwork(ctx.db, 'build');

  const names = await listNetworkNames(ctx.db);

  expect(names).toStrictEqual(['build', 'lab']);
});

test('#removeImp takes a destroyed imp’s memberships with its row', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  const web = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'web', imageId: image.id, slot: 0, networkIds: [network.id] }),
  );

  await createImp(
    ctx.db,
    buildMockNewImp({
      name: 'db',
      imageId: image.id,
      slot: 1,
      ip: '10.66.0.3',
      networkIds: [network.id],
    }),
  );

  await removeImp(ctx.db, web.id);

  const members = await listNetworkMembers(ctx.db);

  expect(members.map((member) => member.name)).toStrictEqual(['db']);
});

test('#removeNetwork takes its memberships with it', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, networkIds: [network.id] }));
  await removeNetwork(ctx.db, network.id);

  const members = await listNetworkMembers(ctx.db);

  expect(members).toStrictEqual([]);
});

test('#writeMember reports a join of an imp not yet on the network as a change', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  invariant(network);

  const isChanged = await writeMember(ctx.db, network.id, imp.id);

  expect(isChanged).toBeTrue();
});

test('#writeMember reports a join of an imp already on the network as no change', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, networkIds: [network.id] }),
  );

  const isChanged = await writeMember(ctx.db, network.id, imp.id);

  expect(isChanged).toBeFalse();
});

test('#removeMember reports a leave of a member as a change', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');

  invariant(network);

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, networkIds: [network.id] }),
  );

  const isChanged = await removeMember(ctx.db, network.id, imp.id);

  expect(isChanged).toBeTrue();
});

test('#removeMember reports a leave of an imp not on the network as no change', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const network = await writeNetwork(ctx.db, 'lab');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  invariant(network);

  const isChanged = await removeMember(ctx.db, network.id, imp.id);

  expect(isChanged).toBeFalse();
});

test('#writeNetworkWithMembers puts a removed network back with its members', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'web', imageId: image.id }));

  const network = buildMockNetworkRecord({
    id: 'net-1',
    name: 'lab',
    createdAt: new Date(1_800_000_000_000),
  });

  await writeNetworkWithMembers(ctx.db, network, [imp.id]);

  const networks = await listNetworks(ctx.db);

  expect(networks).toStrictEqual([
    { id: 'net-1', name: 'lab', createdAt: new Date(1_800_000_000_000), imps: ['web'] },
  ]);
});

test('#writeNetworkWithMembers puts back a network that had no members', async () => {
  const ctx = await createTestDatabase();

  const network = buildMockNetworkRecord({
    id: 'net-1',
    name: 'lab',
    createdAt: new Date(1_800_000_000_000),
  });

  await writeNetworkWithMembers(ctx.db, network, []);

  const networks = await listNetworks(ctx.db);

  expect(networks).toStrictEqual([
    { id: 'net-1', name: 'lab', createdAt: new Date(1_800_000_000_000), imps: [] },
  ]);
});

test('#writeNetworkWithMembers writes nothing when a member is gone', async () => {
  const ctx = await createTestDatabase();

  const network = buildMockNetworkRecord({ name: 'lab' });
  const write = writeNetworkWithMembers(ctx.db, network, ['missing']);

  await write.catch(() => {});

  expect(write).rejects.toThrowWithMessage(Error, /FOREIGN KEY constraint failed/u);

  const names = await listNetworkNames(ctx.db);

  expect(names).toStrictEqual([]);
});
