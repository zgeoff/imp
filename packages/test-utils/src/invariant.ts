// Narrows a value the test needs present: throws when it is `null`,
// `undefined` or `false`, so a matcher that passes on a missing value never
// sees one, and a guard such as `invariant(code === 0)` stops the test.
export function invariant<T>(
  value: T,
  message = 'expected a value',
): asserts value is Exclude<NonNullable<T>, false> {
  if (value === null || value === undefined || value === false) {
    throw new Error(message);
  }
}
