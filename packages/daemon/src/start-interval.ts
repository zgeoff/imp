// Runs `run` every `ms` on a real interval; the returned function stops it.
export function startInterval(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);

  return () => {
    clearInterval(timer);
  };
}
