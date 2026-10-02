import { expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { getThroughProxy } from './http';
import { runShellInImp } from './imp-cli';
import { waitFor } from './wait-for';

// Only guest memory holds it: a token on a tmpfs served by a background httpd,
// its pid and start time, and the boot id. A cold boot loses it all; sleep and
// wake keep it all (docs/architecture/sleep-and-wake.md, finding 1).
export interface MemoryProof {
  readonly name: string;
  readonly token: string;

  // "<pid> <starttime> <boot id>"
  readonly identity: string;
}

function buildIdentityScript(pid: string): string {
  return `echo ${pid} $(cut -d' ' -f22 /proc/${pid}/stat) $(cat /proc/sys/kernel/random/boot_id)`;
}

// Starts busybox httpd on :8080 in an e2e-bare imp, serving the token, and
// waits until the proxy returns it.
export async function startMemoryProof(name: string): Promise<MemoryProof> {
  const token = randomBytes(16).toString('hex');

  const identity = await runShellInImp(
    name,
    [
      'mkdir -p /run/proof && mount -t tmpfs -o size=1m tmpfs /run/proof',
      `echo ${token} > /run/proof/index.html`,
      'setsid httpd -p 8080 -h /run/proof </dev/null >/dev/null 2>&1',
      'sleep 0.3',
      'pid=$(pidof httpd)',
      buildIdentityScript('$pid'),
    ].join('\n'),
  );

  expect(identity.split(' ')).toHaveLength(3);

  await waitFor(`${name} to serve the token`, async () => {
    const body = await getThroughProxy(name);

    expect(body).toBe(token);
  });

  return { name, token, identity };
}

// the same httpd process and boot the proof started
export async function checkMemoryProof(proof: MemoryProof): Promise<void> {
  const pid = proof.identity.split(' ')[0] ?? '';

  const identity = await runShellInImp(proof.name, buildIdentityScript(pid));

  expect(identity).toBe(proof.identity);
}
