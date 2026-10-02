import { posix } from 'node:path';
import type { AcceptConnection, RejectConnection, ServerChannel } from 'ssh2';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import { formatFailure, runChannelRelay } from './channel-io';
import type { SshConnectionContext } from './ssh-connection-context';

// RFC 4254 5.1: the client may not open this channel
const ADMINISTRATIVELY_PROHIBITED = 1;

// The hosts a local forward (`ssh -L`, `-D`) may name: the imp's own
// loopback. Anything else would make impd a way into other guests, the host
// container or the network beyond.
const LOOPBACK_HOSTS: Readonly<Record<string, string>> = {
  localhost: '127.0.0.1',
  '127.0.0.1': '127.0.0.1',
  '::1': '[::1]',
};

// impd's own sockets in the guest, such as a forwarded ssh-agent's. The
// agent dials as root, so a forward could reach another user's agent.
const IMP_RUN_DIR = '/run/imp/';

// the dial target for a direct-streamlocal channel, or null when it is
// refused; the agent refuses a path whose symlinks lead there
export function resolveSocketTarget(socketPath: string): DialTarget | null {
  const path = posix.normalize(posix.join('/', socketPath));

  return path.startsWith(IMP_RUN_DIR) ? null : { network: 'unix', address: path };
}

// the dial target for a direct-tcpip channel, or null when it is refused
export function resolveTcpTarget(host: string, port: number): DialTarget | null {
  const loopback = LOOPBACK_HOSTS[host.toLowerCase()];

  if (loopback === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return { network: 'tcp', address: `${loopback}:${String(port)}` };
}

// A forward channel: the client's bytes to an address in the guest, through
// the agent's dial, and back. The channel opens only once the dial worked,
// so a refused port fails the open (connect failed), as with sshd.
export async function handleForward(
  accept: AcceptConnection<ServerChannel>,
  reject: RejectConnection,
  target: DialTarget | null,
  context: SshConnectionContext,
): Promise<void> {
  if (target === null) {
    reject(ADMINISTRATIVELY_PROHIBITED);

    return;
  }

  let dial: DialStream;

  try {
    await context.awake;

    dial = await context.backend.openDial(context.impName, target, 'ssh');
  } catch (error) {
    context.log(
      `impd: ssh: ${context.impName}: forward to ${target.address}: ${formatFailure(error)}`,
    );

    reject();

    return;
  }

  try {
    await runChannelRelay(accept(), dial);
  } catch (error) {
    context.log(
      `impd: ssh: ${context.impName}: forward to ${target.address}: ${formatFailure(error)}`,
    );
  }
}
