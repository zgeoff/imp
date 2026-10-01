// The message of a thrown value, which need not be an Error.
export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
