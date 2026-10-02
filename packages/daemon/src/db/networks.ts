import type { ImpDatabase } from './open-database';

// Private networks between imps (docs/guides/networks.md): the networks,
// and which imps are on each.

export interface NetworkRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;

  // its members' names, sorted
  readonly imps: readonly string[];
}

// one imp on one network, as the firewall and the resolver see it
export interface NetworkMember {
  readonly network: string;
  readonly impId: string;
  readonly name: string;
  readonly slot: number;
  readonly guestIp: string;
}

// null when a network by that name exists
export async function writeNetwork(db: ImpDatabase, name: string): Promise<NetworkRecord | null> {
  const row = await db
    .insertInto('networks')
    .values({ id: Bun.randomUUIDv7(), name, created_at: Date.now() })
    .onConflict((conflict) => conflict.column('name').doNothing())
    .returningAll()
    .executeTakeFirst();

  return row === undefined
    ? null
    : { id: row.id, name: row.name, createdAt: new Date(row.created_at), imps: [] };
}

export async function findNetworkByName(
  db: ImpDatabase,
  name: string,
): Promise<NetworkRecord | undefined> {
  const networks = await listNetworks(db);

  return networks.find((network) => network.name === name);
}

export async function listNetworks(db: ImpDatabase): Promise<NetworkRecord[]> {
  const rows = await db.selectFrom('networks').selectAll().orderBy('name').execute();

  const members = await db
    .selectFrom('network_members')
    .innerJoin('imps', 'imps.id', 'network_members.imp_id')
    .select(['network_members.network_id', 'imps.name'])
    .orderBy('imps.name')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at),
    imps: members.filter((member) => member.network_id === row.id).map((member) => member.name),
  }));
}

// its memberships go with it
export async function removeNetwork(db: ImpDatabase, id: string): Promise<void> {
  await db.deleteFrom('networks').where('id', '=', id).execute();
}

// false when the imp is on the network already
export async function writeMember(
  db: ImpDatabase,
  networkId: string,
  impId: string,
): Promise<boolean> {
  const result = await db
    .insertInto('network_members')
    .values({ network_id: networkId, imp_id: impId })
    .onConflict((conflict) => conflict.doNothing())
    .executeTakeFirst();

  return result.numInsertedOrUpdatedRows === 1n;
}

// false when the imp is not on the network
export async function removeMember(
  db: ImpDatabase,
  networkId: string,
  impId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('network_members')
    .where('network_id', '=', networkId)
    .where('imp_id', '=', impId)
    .executeTakeFirst();

  return result.numDeletedRows === 1n;
}

export async function listNetworkMembers(db: ImpDatabase): Promise<NetworkMember[]> {
  const rows = await db
    .selectFrom('network_members')
    .innerJoin('networks', 'networks.id', 'network_members.network_id')
    .innerJoin('imps', 'imps.id', 'network_members.imp_id')
    .select(['networks.name as network', 'imps.id', 'imps.name', 'imps.slot', 'imps.ip'])
    .orderBy('networks.name')
    .orderBy('imps.name')
    .execute();

  return rows.map((row) => ({
    network: row.network,
    impId: row.id,
    name: row.name,
    slot: row.slot,
    guestIp: row.ip,
  }));
}
