import * as z from 'zod';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';

const ServeStatusSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
});

// The tailnet ports `tailscale serve` holds, from `tailscale serve status
// --json`. tailscaled takes such a port on the tailnet IP itself, so a
// listener of impd's on it never sees the traffic. Empty for no config.
export function parseServePorts(json: string): readonly number[] {
  try {
    // no serve config prints nothing
    const text = json.trim() === '' ? '{}' : json;
    const status = ServeStatusSchema.parse(JSON.parse(text));

    return Object.keys(status.TCP ?? {})
      .map(Number)
      .filter((port) => Number.isInteger(port));
  } catch {
    return [];
  }
}

// The ports `tailscale serve` holds now; none when tailscale fails or is
// missing. `run` runs the command, runCommand by default.
export async function readServePorts(
  run: (argv: readonly string[]) => Promise<CommandResult> = runCommand,
): Promise<readonly number[]> {
  try {
    const result = await run(['tailscale', 'serve', 'status', '--json']);

    return result.exitCode === 0 ? parseServePorts(result.stdout) : [];
  } catch {
    return [];
  }
}
