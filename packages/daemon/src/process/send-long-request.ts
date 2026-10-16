import type { StartTimer } from './clock';
import { startRealTimer } from './start-real-timer';

// when the call gives up, and what it throws then
export interface RequestDeadline {
  readonly ms: number;
  readonly buildError: () => Error;
}

export interface LongRequestOptions {
  // from the start of the call to the answer's headers; null leaves the
  // caller's signal as the only end
  readonly deadline: RequestDeadline | null;

  // the deadline's timer, returning its cancel; setTimeout by default
  readonly startTimer?: StartTimer;

  // the transport: the global fetch with Bun's idle limit lifted, by default
  readonly send?: (request: Request) => Promise<Response>;
}

// Bun's fetch ends an answer silent for 360 s unless the call passes
// `timeout: false`. This lifts it, and at the deadline aborts the request and
// throws the deadline's error, even when the transport ignores the abort.
export async function sendLongRequest(
  url: string,
  init: Readonly<RequestInit>,
  options: Readonly<LongRequestOptions>,
): Promise<Response> {
  const send = options.send ?? ((request: Request) => fetch(request, { timeout: false }));
  const deadline = options.deadline;

  if (deadline === null) {
    return send(new Request(url, init));
  }

  const expiry = new AbortController();

  const expired = Promise.withResolvers<never>();

  const signal =
    init.signal === undefined || init.signal === null
      ? expiry.signal
      : AbortSignal.any([init.signal, expiry.signal]);

  const startTimer = options.startTimer ?? startRealTimer;

  const cancel = startTimer(() => {
    const error = deadline.buildError();

    expiry.abort(error);
    expired.reject(error);
  }, deadline.ms);

  try {
    return await Promise.race([send(new Request(url, { ...init, signal })), expired.promise]);
  } finally {
    cancel();
  }
}
