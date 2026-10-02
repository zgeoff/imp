// true when `promise` settles within `ms`, false when it is still pending;
// a rejection passes through
export async function waitWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = Promise.withResolvers<boolean>();

  const timeout = setTimeout(() => {
    timer.resolve(false);
  }, ms);

  try {
    return await Promise.race([
      (async () => {
        await promise;

        return true;
      })(),
      timer.promise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
