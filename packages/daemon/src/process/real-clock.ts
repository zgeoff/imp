import type { Clock } from './clock';
import { startRealTimer } from './start-real-timer';

// the host's own time: Date.now, setTimeout and Bun.sleep
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  startTimer: startRealTimer,
  sleep: (ms) => Bun.sleep(ms),
};
