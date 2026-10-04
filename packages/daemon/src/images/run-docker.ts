import { ORPCError } from '@orpc/server';
import { readProxyRefusal } from '../docker-proxy/refusal';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';

interface DockerOptions {
  // the whole environment of the CLI; impd's own by default
  readonly env?: Readonly<Record<string, string>> | undefined;

  // kills the child when it aborts
  readonly signal?: AbortSignal;
}

// A refusal by imp-docker-proxy as the client's BAD_REQUEST, with the
// proxy's message alone (docs/architecture/host-contract.md#the-docker-socket);
// null when the output holds none
export function readRefusalError(call: string, output: string): ORPCError<string, unknown> | null {
  const refusal = readProxyRefusal(output);

  if (refusal === null) {
    return null;
  }

  console.warn(`impd: ${call} refused: ${refusal}`);

  return new ORPCError('BAD_REQUEST', { message: refusal });
}

// A docker CLI call, which goes through imp-docker-proxy on imp-host. Like
// runCommand, it never throws on a non-zero exit, except on a refusal.
export async function runDocker(
  argv: readonly string[],
  options: DockerOptions = {},
): Promise<CommandResult> {
  const result = await runCommand(['docker', ...argv], {
    ...(options.env !== undefined && { env: options.env }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  if (result.exitCode !== 0) {
    const refused = readRefusalError(`docker ${argv[0] ?? ''}`, result.stderr);

    if (refused !== null) {
      throw refused;
    }
  }

  return result;
}

// Like runDocker, but throws with stderr on any other non-zero exit.
export async function runDockerChecked(
  argv: readonly string[],
  options: DockerOptions = {},
): Promise<string> {
  const result = await runDocker(argv, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout;
}
