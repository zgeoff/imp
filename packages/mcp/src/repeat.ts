// Runs `tick` every `ms` until the returned stop is called: the timer behind
// a call's progress and an event stream's keepalive. A test passes one it
// steps itself.
export type Repeat = (ms: number, tick: () => void) => () => void;

export function runOnInterval(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms);

  return () => {
    clearInterval(timer);
  };
}
