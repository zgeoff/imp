import { runInContainer } from './instance';

// The guest's available memory in MiB from Firecracker's GET
// /balloon/statistics answer, whose sizes are bytes.
export function parseBalloonAvailableMib(text: string): number {
  const parsed: unknown = JSON.parse(text);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('available_memory' in parsed) ||
    typeof parsed.available_memory !== 'number'
  ) {
    throw new Error(`no available_memory in ${text}`);
  }

  return Math.floor(parsed.available_memory / 1_048_576);
}

// What impd's memory controller reads for an awake imp: the balloon
// statistics on its Firecracker's API socket, jailed or not, which lag the
// guest (docs/architecture/memory.md#growing).
export async function readBalloonAvailableMib(impId: string): Promise<number> {
  const socket = `/var/lib/imp/imps/${impId}/run/api.sock`;

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

  return parseBalloonAvailableMib(result.stdout);
}
