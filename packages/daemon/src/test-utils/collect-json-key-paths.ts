// Every key path in a JSON value, sorted: `a`, `a.b`, and `a[]` for an
// array's items, so `a[].b` for a key of an item. A fixture's paths show
// which fields it sets.
export function collectJsonKeyPaths(value: unknown, prefix = ''): string[] {
  const paths = new Set<string>();

  if (Array.isArray(value)) {
    const items = `${prefix}[]`;

    paths.add(items);

    for (const item of value) {
      for (const path of collectJsonKeyPaths(item, items)) {
        paths.add(path);
      }
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;

      paths.add(path);

      for (const nested of collectJsonKeyPaths(child, path)) {
        paths.add(nested);
      }
    }
  }

  return [...paths].toSorted();
}
