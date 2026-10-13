import type { StartTimer } from './clock';
import { startRealTimer } from './start-real-timer';

// `promise`'s value when it settles within `ms`; otherwise throws the error
// `buildError` makes, and leaves `promise` running. A rejection passes
// through. `startTimer` is setTimeout's by default.
export async function requireWithin<T>(
  promise: Promise<T>,
  ms: number,
  buildError: () => Error,
  startTimer: StartTimer = startRealTimer,
): Promise<T> {
  const timer = Promise.withResolvers<never>();

  const cancel = startTimer(() => {
    timer.reject(buildError());
  }, ms);

  try {
    return await Promise.race([promise, timer.promise]);
  } finally {
    cancel();
  }
}
