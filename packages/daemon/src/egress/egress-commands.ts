import { runCommand } from '../process/run-command';

// The commands the egress service runs past nft, each from `run`

type CommandRunner = typeof runCommand;

// setup-net.sh's FORWARD rules, as `iptables -S FORWARD` prints them
export async function runForwardRulesList(run: CommandRunner = runCommand): Promise<string> {
  const result = await run(['iptables', '-S', 'FORWARD']);

  if (result.exitCode !== 0) {
    throw new Error(
      `iptables -S FORWARD exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
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
    const result = await run(['conntrack', '-D', '-s', source, '-d', destination]);

    if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
      throw new Error(
        `conntrack -D -s ${source} -d ${destination} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
  }
}

// `conntrack -D` exits 1 when it found nothing to delete
export async function runConntrackFlush(
  guestIp: string,
  run: CommandRunner = runCommand,
): Promise<void> {
  const result = await run(['conntrack', '-D', '-s', guestIp]);

  if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
    throw new Error(
      `conntrack -D -s ${guestIp} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
}
