import { CompiledQuery } from 'kysely';
import type { ImpQueries } from '../db/open-database';

// One SQL statement, with `?` placeholders for `parameters`, against a test's
// database: a fault to inject, such as a trigger that refuses a write, or a
// row as an older impd wrote it. Returns the rows a select reads.
export async function runSql(
  db: ImpQueries,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<unknown[]> {
  const result = await db.executeQuery(CompiledQuery.raw(text, [...parameters]));

  return result.rows;
}
