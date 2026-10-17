// the entries of gunshi's sub-command table, which a command gives as a
// record or a map
export function listEntries<T>(
  table: Readonly<Record<string, T>> | ReadonlyMap<string, T>,
): [string, T][] {
  return isMap(table) ? [...table] : Object.entries(table);
}

function isMap<T>(
  table: Readonly<Record<string, T>> | ReadonlyMap<string, T>,
): table is ReadonlyMap<string, T> {
  return table instanceof Map;
}
