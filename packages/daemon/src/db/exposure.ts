import { PublicAuthSchema } from '@imp/api';
import type { ImpState } from '@imp/api';
import type { StoredPublicAuth } from './imps';
import type { ImpDatabase } from './open-database';

// A public imp as the public listeners see it
export interface PublicImp {
  readonly id: string;

  // a request to an imp that is not running wakes it, which has a limit
  readonly state: ImpState;
  readonly stored: StoredPublicAuth;
}

// The public listeners' view of an imp: its stored auth while it is public,
// undefined for a tailnet-only or unknown imp, which both get the same 404.
export async function findPublicImp(db: ImpDatabase, name: string): Promise<PublicImp | undefined> {
  const row = await db
    .selectFrom('imps')
    .select(['id', 'state', 'exposure', 'public_auth', 'public_user', 'public_hash'])
    .where('name', '=', name)
    .executeTakeFirst();

  const auth = PublicAuthSchema.safeParse(row?.public_auth);

  // a value impd did not write is tailnet-only: closed, never open
  if (row?.exposure !== 'public' || !auth.success) {
    return undefined;
  }

  // token and basic auth without a hash would let anyone in
  if (auth.data !== 'none' && row.public_hash === null) {
    return undefined;
  }

  return {
    id: row.id,
    state: row.state,
    stored: { auth: auth.data, user: row.public_user, hash: row.public_hash },
  };
}

// the names the public A records are for
export async function listPublicImpNames(db: ImpDatabase): Promise<string[]> {
  const rows = await db
    .selectFrom('imps')
    .select('name')
    .where('exposure', '=', 'public')
    .orderBy('name')
    .execute();

  return rows.map((row) => row.name);
}
