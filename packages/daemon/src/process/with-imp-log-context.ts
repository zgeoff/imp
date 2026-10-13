import { withContext } from '@logtape/logtape';

// Runs `run` with `imp` as the imp of every log line it writes, awaited work
// included, as setupLogging's context storage carries it.
export function withImpLogContext<T>(imp: string, run: () => T): T {
  return withContext({ imp }, run);
}
