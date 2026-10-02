import { EgressPolicySchema } from '@imp/api';
import type { EgressPolicy } from '@imp/api';
import type { ImpDatabase } from './open-database';

// An imp as the egress firewall and resolver see it
export interface EgressSlot {
  readonly impId: string;
  readonly name: string;
  readonly slot: number;
  readonly guestIp: string;
  readonly policy: EgressPolicy;
}

// none blocks everything: a value impd did not write fails closed
const CLOSED: EgressPolicy = { mode: 'none', allow: [] };

export function parseStoredPolicy(mode: string, allow: string): EgressPolicy {
  try {
    const parsed = EgressPolicySchema.safeParse({ mode, allow: JSON.parse(allow) as unknown });

    return parsed.success ? parsed.data : CLOSED;
  } catch {
    return CLOSED;
  }
}

export async function readEgressPolicy(
  db: ImpDatabase,
  impId: string,
): Promise<EgressPolicy | undefined> {
  const row = await db
    .selectFrom('imps')
    .select(['egress_policy', 'egress_allow'])
    .where('id', '=', impId)
    .executeTakeFirst();

  return row === undefined ? undefined : parseStoredPolicy(row.egress_policy, row.egress_allow);
}

export async function writeEgressPolicy(
  db: ImpDatabase,
  impId: string,
  policy: EgressPolicy,
): Promise<void> {
  await db
    .updateTable('imps')
    .set({ egress_policy: policy.mode, egress_allow: JSON.stringify(policy.allow) })
    .where('id', '=', impId)
    .execute();
}

export async function listEgressSlots(db: ImpDatabase): Promise<EgressSlot[]> {
  const rows = await db
    .selectFrom('imps')
    .select(['id', 'name', 'slot', 'ip', 'egress_policy', 'egress_allow'])
    .orderBy('slot')
    .execute();

  return rows.map((row) => ({
    impId: row.id,
    name: row.name,
    slot: row.slot,
    guestIp: row.ip,
    policy: parseStoredPolicy(row.egress_policy, row.egress_allow),
  }));
}
