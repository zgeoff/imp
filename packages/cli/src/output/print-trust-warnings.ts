import type { CommandIO } from '../cli/command-io';
import type { ImpClient } from '../config/create-imp-client';

// what impd says of the imp's networks after a change that can mix open
// imps with box ones; on stderr, so --json stays one document
export async function printTrustWarnings(
  client: ImpClient,
  io: CommandIO,
  name: string,
): Promise<void> {
  const warnings = await client.networks.warnings({ name });

  for (const warning of warnings) {
    io.printError(`warning: ${warning}`);
  }
}
