// Narrows a value the test needs present: throws when it is `null` or
// `undefined`, so a matcher that passes on a missing value never sees one.
export function invariant<T>(
  value: T,
  message = 'expected a value',
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}
