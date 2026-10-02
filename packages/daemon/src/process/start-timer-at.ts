// setTimeout's longest delay: a longer one overflows, warns, and fires at once
const MAX_DELAY_MS = 2 ** 31 - 1;

// starts a timer and returns its cancel
type StartTimer = (fire: () => void, ms: number) => () => void;

interface TimerAtOptions {
  readonly now: () => number;

  // setTimeout by default; a test passes a fake clock's
  readonly startTimer?: StartTimer;
}

function startRealTimer(fire: () => void, ms: number): () => void {
  const timer = setTimeout(fire, ms);

  return () => {
    clearTimeout(timer);
  };
}

// the cancel before the first step starts
function stopNothing(): void {}

// Calls `fire` once at `at`, however far off: a delay past setTimeout's limit
// waits the limit, then checks the clock again. An `at` that is not a finite
// time fires at once. Returns the cancel.
export function startTimerAt(
  fire: () => void,
  at: number,
  options: Readonly<TimerAtOptions>,
): () => void {
  const startTimer = options.startTimer ?? startRealTimer;
  let stopStep: () => void = stopNothing;

  const startStep = (): void => {
    const remaining = Number.isFinite(at) ? at - options.now() : 0;

    if (remaining <= MAX_DELAY_MS) {
      stopStep = startTimer(fire, Math.max(0, remaining));

      return;
    }

    stopStep = startTimer(startStep, MAX_DELAY_MS);
  };

  startStep();

  return () => {
    stopStep();
  };
}
