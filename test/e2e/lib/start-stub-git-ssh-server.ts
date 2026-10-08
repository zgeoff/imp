import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server, utils } from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';
import { runChecked } from './instance';

// A git server over SSH on this machine, as a forge would be: one public
// key, and one command, a push to one bare repo. Imps reach it through the
// host container's NAT; #26's egress policies may block private ranges.

export interface StubGitSshServer {
  readonly port: number;

  // `ssh-ed25519 AAAA...`, for the imp's known_hosts
  readonly hostKey: string;

  // the bare repo that pushes land in
  readonly repo: string;

  // logins whose signature the key verified
  readonly logins: () => number;

  // closes the listener once open connections end
  readonly stop: () => Promise<void>;
}

const RECEIVE_PACK = /^git-receive-pack '\/?repo\.git'$/;

function runReceivePack(channel: ServerChannel, repo: string): void {
  const child = spawn('git', ['receive-pack', repo], { stdio: 'pipe' });

  channel.pipe(child.stdin);
  child.stdout.pipe(channel, { end: false });
  child.stderr.pipe(channel.stderr, { end: false });

  child.once('close', (code) => {
    channel.exit(code ?? 1);
    channel.end();
  });
}

function handleConnection(
  client: Connection,
  allowedKey: string,
  repo: string,
  onLogin: () => void,
): void {
  const allowed = utils.parseKey(allowedKey);

  client.on('authentication', (ctx) => {
    const isKey =
      ctx.method === 'publickey' &&
      !(allowed instanceof Error) &&
      ctx.key.data.equals(allowed.getPublicSSH());

    if (!isKey || allowed instanceof Error) {
      ctx.reject(['publickey']);

      return;
    }

    // a key query: the client asks before it signs
    if (ctx.signature === undefined || ctx.blob === undefined) {
      ctx.accept();

      return;
    }

    if (!allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
      ctx.reject(['publickey']);

      return;
    }

    onLogin();

    ctx.accept();
  });

  client.on('session', (accept) => {
    accept().on('exec', (acceptExec, _reject, info) => {
      const channel = acceptExec();

      if (RECEIVE_PACK.test(info.command)) {
        runReceivePack(channel, repo);

        return;
      }

      channel.stderr.write(`only git push to repo.git: ${info.command}\n`);
      channel.exit(1);
      channel.end();
    });
  });

  client.on('error', () => {
    client.end();
  });
}

export async function startStubGitSshServer(
  address: string,
  dir: string,
  allowedKey: string,
): Promise<StubGitSshServer> {
  const hostKeyPath = join(dir, 'git-host-key');
  const repo = join(dir, 'repo.git');

  await runChecked(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', hostKeyPath]);
  await runChecked(['git', 'init', '-q', '--bare', '-b', 'main', repo]);

  const counts = { logins: 0 };

  const server = new Server({ hostKeys: [readFileSync(hostKeyPath)] }, (client) => {
    handleConnection(client, allowedKey, repo, () => {
      counts.logins += 1;
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, address, resolve);
  });

  const listening = server.address();

  return {
    port: typeof listening === 'object' && listening !== null ? listening.port : 0,
    hostKey: readFileSync(`${hostKeyPath}.pub`, 'utf8').split(' ').slice(0, 2).join(' '),
    repo,
    logins: () => counts.logins,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
