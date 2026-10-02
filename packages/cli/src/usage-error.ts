// A mistake in how the command was called, not a failure of the call: the
// CLI exits 2 for it, as for an unknown flag.
export class UsageError extends Error {
  override name = 'UsageError';
}
