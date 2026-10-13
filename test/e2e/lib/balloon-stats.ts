import { runInContainer } from './instance';

export interface BalloonStats {
  readonly totalMib: number;
  readonly availableMib: number;
}

// The guest's total and available memory in MiB from Firecracker's GET
// /balloon/statistics answer, whose sizes are bytes.
export function parseBalloonStats(text: string): BalloonStats {
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`no balloon statistics in ${text}`);
  }

  return {
    totalMib: readMib(parsed, 'total_memory', text),
    availableMib: readMib(parsed, 'available_memory', text),
  };
}

function readMib(parsed: object, key: string, text: string): number {
  const bytes: unknown = Reflect.get(parsed, key);

  if (typeof bytes !== 'number') {
    throw new TypeError(`no ${key} in ${text}`);
  }

  return Math.floor(bytes / 1_048_576);
}

// What impd's memory controller reads for an awake imp: the balloon
// statistics on its Firecracker's API socket, jailed or not, which lag the
// guest (docs/architecture/memory.md#growing).
export async function readBalloonStats(impID: string): Promise<BalloonStats> {
  const socket = `/var/lib/imp/imps/${impID}/run/api.sock`;

  const result = await runInContainer([
    'curl',
    '--silent',
    '--fail',
    '--unix-socket',
    socket,
    'http://localhost/balloon/statistics',
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`GET /balloon/statistics on ${socket} exited ${String(result.exitCode)}`);
  }

  return parseBalloonStats(result.stdout);
}
