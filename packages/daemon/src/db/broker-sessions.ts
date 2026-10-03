import type { ImpDatabase } from './open-database';

// The sessions started with `require: ['broker']`, by execution generation:
// one run of a session's process, which a sleep, a wake and an impd restart
// keep, and which no later run repeats.

export async function isBrokerSession(
  db: ImpDatabase,
  impId: string,
  generation: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('broker_sessions')
    .select('generation')
    .where('imp_id', '=', impId)
    .where('generation', '=', generation)
    .executeTakeFirst();

  return row !== undefined;
}

// the new one, and of the rest only those still `running`, so the rows
// never outgrow the imp's live sessions
export async function writeBrokerSession(
  db: ImpDatabase,
  impId: string,
  generation: string,
  running: readonly string[],
): Promise<void> {
  const kept = [generation, ...running];

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('broker_sessions')
      .values({ imp_id: impId, generation, at: Date.now() })
      .onConflict((conflict) => conflict.columns(['imp_id', 'generation']).doNothing())
      .execute();

    await trx
      .deleteFrom('broker_sessions')
      .where('imp_id', '=', impId)
      .where('generation', 'not in', kept)
      .execute();
  });
}
