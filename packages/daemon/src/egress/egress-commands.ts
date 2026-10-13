import { buildExitError, runCommand } from '../process/run-command';
import type { CommandRunner } from '../process/run-command';

// The commands the egress service runs past nft, each from `run`. A failure
// names stderr alone, never stdout.

// setup-net.sh's FORWARD rules, as `iptables -S FORWARD` prints them
export async function runForwardRulesList(run: CommandRunner = runCommand): Promise<string> {
  const argv = ['iptables', '-S', 'FORWARD'];

  const result = await run(argv);

  if (result.exitCode !== 0) {
    throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
  }

  return result.stdout;
}

// both directions: conntrack matches -s and -d on a flow's original tuple
export async function runPairFlush(
  first: string,
  second: string,
  run: CommandRunner = runCommand,
): Promise<void> {
  for (const [source, destination] of [
    [first, second],
    [second, first],
  ] as const) {
    const argv = ['conntrack', '-D', '-s', source, '-d', destination];

    const result = await run(argv);

    if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
      throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
    }
  }
}

// `conntrack -D` exits 1 when it found nothing to delete
export async function runConntrackFlush(
  guestIp: string,
  run: CommandRunner = runCommand,
): Promise<void> {
  const argv = ['conntrack', '-D', '-s', guestIp];

  const result = await run(argv);

  if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
    throw buildExitError(argv, { exitCode: result.exitCode, stderr: result.stderr });
  }
}
