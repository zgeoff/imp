// starts a timer that calls `fire` once after `ms`, and returns its cancel
export type StartTimer = (fire: () => void, ms: number) => () => void;

const HOUR_MS = 60 * 60 * 1000;

// The calls that answer only when their work ends, which can be later than
// Bun's fetch waits for a silent answer (360 s): each waits this long instead.
export const LONG_CALL_DEADLINES_MS: ReadonlyMap<string, number> = new Map([
  ['backups.run', 24 * HOUR_MS],
  ['backups.restore', 24 * HOUR_MS],
  ['backups.check', 24 * HOUR_MS],
  ['images.add', 6 * HOUR_MS],
  ['images.build', 6 * HOUR_MS],
  ['system.gc', HOUR_MS],
  ['moves.abort', HOUR_MS],
  ['moves.resume', HOUR_MS],
]);

// what oRPC's link passes a fetch beside the request
export interface CallInit {
  readonly redirect?: Request['redirect'];
}

interface LongCall {
  // the procedure, as `backups.run`
  readonly procedure: string;
  readonly deadlineMs: number;
  readonly startTimer: StartTimer;

  // the transport; the global fetch with Bun's idle limit lifted when null
  readonly send: ((request: Request) => Promise<Response>) | null;
}

// One call of LONG_CALL_DEADLINES_MS: Bun's limit lifted (`timeout: false`),
// and at the deadline the request aborts with a TimeoutError that names it.
export async function sendLongCall(
  request: Request,
  init: Readonly<CallInit>,
  call: Readonly<LongCall>,
): Promise<Response> {
  // one controller for the caller's abort and the deadline, since a browser
  // the SDK serves (Firefox 121–123) has no AbortSignal.any
  const limit = new AbortController();

  const expired = Promise.withResolvers<never>();

  const onCallerAbort = (): void => {
    limit.abort(request.signal.reason);
  };

  request.signal.addEventListener('abort', onCallerAbort, { once: true });

  if (request.signal.aborted) {
    onCallerAbort();
  }

  const cancel = call.startTimer(() => {
    const error = new DOMException(
      `impd sent no answer to ${call.procedure} in ${formatHours(call.deadlineMs)}`,
      'TimeoutError',
    );

    limit.abort(error);
    expired.reject(error);
  }, call.deadlineMs);

  const signal = limit.signal;

  const limited = new Request(request, { signal });

  const sent =
    call.send === null ? fetch(limited, { ...init, signal, timeout: false }) : call.send(limited);

  try {
    return await Promise.race([sent, expired.promise]);
  } finally {
    cancel();

    request.signal.removeEventListener('abort', onCallerAbort);
  }
}

function formatHours(ms: number): string {
  const hours = ms / HOUR_MS;

  return hours === 1 ? 'an hour' : `${String(hours)} hours`;
}
