import type { StartTimer } from './clock';
import { startRealTimer } from './start-real-timer';

// true when `promise` settles within `ms`, false when it is still pending;
// a rejection passes through. `startTimer` is setTimeout's by default.
export async function waitWithin(
  promise: Promise<unknown>,
  ms: number,
  startTimer: StartTimer = startRealTimer,
): Promise<boolean> {
  const timer = Promise.withResolvers<boolean>();

  const cancel = startTimer(() => {
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
    cancel();
  }
}
