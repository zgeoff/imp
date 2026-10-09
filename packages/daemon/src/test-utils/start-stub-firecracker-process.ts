import { onTestFinished } from 'bun:test';
import { readFileSync } from 'node:fs';
import { waitFor } from '@imp/test-utils/wait-for';

// A process whose /proc cmdline reads `firecracker ... --api-sock <socket>`,
// as a real one's does; it serves nothing. It is killed when the test ends.
export async function startStubFirecrackerProcess(apiSocket: string) {
  const child = Bun.spawn([
    'bash',
    '-c',
    `exec -a firecracker bash -c 'sleep 30; true' x --api-sock "$0"`,
    apiSocket,
  ]);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  // the socket is in bash's own command line before the exec renames it
  await waitFor(() => {
    const cmdline = readFileSync(`/proc/${String(child.pid)}/cmdline`, 'utf8').split('\0');

    if (cmdline[0] !== 'firecracker' || !cmdline.includes(apiSocket)) {
      throw new Error(`the stand-in has not exec'd yet: ${cmdline.join(' ')}`);
    }
  });

  return child;
}
