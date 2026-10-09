// Runs `fire` once after `ms`, unless the returned cancel runs first: the
// timer behind a command's deadline and its kill grace. A test passes one it
// fires itself.
export type After = (ms: number, fire: () => void) => () => void;

export function runAfter(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);

  return () => {
    clearTimeout(timer);
  };
}
