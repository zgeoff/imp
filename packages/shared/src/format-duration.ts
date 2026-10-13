// "45s", "12m", "3h 20m"
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) {
    return `${String(Math.floor(ms / 1000))}s`;
  }

  if (minutes < 60) {
    return `${String(minutes)}m`;
  }

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
