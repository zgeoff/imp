import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from './instance';
import { REPO_ROOT, instance, runChecked, runCommand, runInContainer } from './instance';

// the Host aliases the suite's ssh config defines: the gateway with the
// authorized key, and with a key it does not authorize
export const SSH_HOST = 'imp-e2e';
export const SSH_HOST_OTHER_KEY = 'imp-e2e-other-key';

// marks the suite's line in authorized_keys, so cleanup removes only it
const KEY_COMMENT = 'imp-e2e-ssh-suite';
const AUTHORIZED_KEYS = '/var/lib/imp/ssh/authorized_keys';

export interface SshClient {
  // `ssh -F <config>`: the start of every ssh, scp and sftp command
  readonly configArgs: readonly string[];

  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

async function createKey(path: string, comment: string): Promise<string> {
  await runChecked(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path]);

  return Bun.file(`${path}.pub`).text();
}

// A key for the dev instance's gateway, authorized in its data directory,
// and an ssh config for the gateway's published port. The config turns off
// OpenSSH's post-quantum warning, which ssh2 cannot satisfy.
export async function setupSshClient(): Promise<SshClient> {
  // the worktree's cache, not /tmp: the scp test writes its payloads here
  const scratch = join(REPO_ROOT, '.cache', 'e2e');

  mkdirSync(scratch, { recursive: true });

  const dir = mkdtempSync(join(scratch, 'ssh-'));
  const key = join(dir, 'id');
  const otherKey = join(dir, 'other');
  const config = join(dir, 'config');

  const publicKey = await createKey(key, KEY_COMMENT);

  await createKey(otherKey, 'not-authorized');

  // a run cut short leaves its key; this run's replaces it
  const added = await runInContainer([
    'sh',
    '-c',
    `umask 077 && touch ${AUTHORIZED_KEYS} && sed -i '/${KEY_COMMENT}/d' ${AUTHORIZED_KEYS} && printf '%s' "$0" >> ${AUTHORIZED_KEYS}`,
    publicKey,
  ]);

  if (added.exitCode !== 0) {
    throw new Error(`could not authorize the suite's key: ${added.stderr.trim()}`);
  }

  const buildHostBlock = (alias: string, identity: string): string[] => [
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  Port ${String(instance.sshPort)}`,
    `  IdentityFile ${identity}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
    '  StrictHostKeyChecking accept-new',
    '  BatchMode yes',
    '  LogLevel ERROR',
    '  IgnoreUnknown WarnWeakCrypto',
    '  WarnWeakCrypto no',
  ];

  writeFileSync(
    config,
    [...buildHostBlock(SSH_HOST, key), ...buildHostBlock(SSH_HOST_OTHER_KEY, otherKey), ''].join(
      '\n',
    ),
  );

  return {
    configArgs: ['-F', config],
    dir,
    cleanup: async () => {
      await runInContainer(['sed', '-i', `/${KEY_COMMENT}/d`, AUTHORIZED_KEYS]);

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// `ssh <user>@imp-e2e ARGS...`, as a user would run it
export function runSsh(
  client: SshClient,
  user: string,
  args: readonly string[],
  options: Readonly<{ stdin?: string; host?: string; env?: Readonly<Record<string, string>> }> = {},
): Promise<CommandResult> {
  const host = options.host ?? SSH_HOST;

  return runCommand(['ssh', ...client.configArgs, `${user}@${host}`, ...args], options);
}

// `ssh ARGS...` in the background, until the test stops it
export function startSsh(
  client: SshClient,
  args: readonly string[],
  stdin?: string,
  env: Readonly<Record<string, string>> = {},
) {
  const proc = Bun.spawn(['ssh', ...client.configArgs, ...args], {
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });

  return {
    proc,
    stop: async () => {
      proc.kill();

      await proc.exited;
    },
  };
}

// The user's ssh-agent on this machine, holding a key made for the run.
export interface LocalSshAgent extends AsyncDisposable {
  // SSH_AUTH_SOCK for `ssh -A`
  readonly socket: string;
  readonly publicKey: string;

  // the private key file, to look for its bytes where they must not be
  readonly keyPath: string;
}

export async function startLocalSshAgent(client: SshClient): Promise<LocalSshAgent> {
  const socket = join(client.dir, 'agent.sock');
  const keyPath = join(client.dir, 'laptop');

  const publicKey = await createKey(keyPath, 'imp-e2e-laptop');

  // -D: in the foreground, so the suite owns the process
  const agent = Bun.spawn(['ssh-agent', '-D', '-a', socket], { stdout: 'ignore', stderr: 'pipe' });

  // a run that bails skips afterAll; the agent still goes with the process
  process.once('exit', () => {
    agent.kill();
  });

  await waitForSocket(socket);
  await runCommand(['ssh-add', '-q', keyPath], { env: { SSH_AUTH_SOCK: socket } });

  return {
    socket,
    publicKey,
    keyPath,
    [Symbol.asyncDispose]: async () => {
      agent.kill();

      await agent.exited;
    },
  };
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`ssh-agent did not make ${path}`);
    }

    await Bun.sleep(20);
  }
}

// The IPv6 link-local address of the host end of the tap whose IPv4
// address is `hostIp`: the other way a guest could reach the host container.
export async function readTapLinkLocal(hostIp: string): Promise<string> {
  const v4 = await runInContainer(['ip', '-o', '-4', 'addr', 'show', 'to', hostIp]);

  const tap = /^\d+: (?<tap>\S+)/.exec(v4.stdout)?.groups?.['tap'];

  if (tap === undefined) {
    throw new Error(`no interface has ${hostIp}: ${v4.stdout}${v4.stderr}`);
  }

  const v6 = await runInContainer(['ip', '-o', '-6', 'addr', 'show', 'dev', tap, 'scope', 'link']);

  const linkLocal = /inet6 (?<ip>[\da-f:]+)/.exec(v6.stdout)?.groups?.['ip'];

  if (linkLocal === undefined) {
    throw new Error(`${tap} has no link-local address: ${v6.stdout}${v6.stderr}`);
  }

  return linkLocal;
}

// a free port on this machine for a local forward
export function findFreePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = server.port;

  server.stop(true);

  return port;
}
