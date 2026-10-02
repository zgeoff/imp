// What the promise rejected with, or null when it resolved. An assertion on
// the result runs before the test ends, which an un-awaited
// `expect(...).rejects` does not promise.
export async function readRejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }

  return null;
}
