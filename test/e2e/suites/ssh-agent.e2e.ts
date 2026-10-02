import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { utils } from 'ssh2';
import { resolveImageName } from '../lib/fixtures';
import { startGitSshServer } from '../lib/git-ssh-server';
import type { GitSshServer } from '../lib/git-ssh-server';
import { requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { readContainerGateway, runChecked, runCommand, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { SSH_HOST, runSsh, setupSshClient, startLocalSshAgent, startSsh } from '../lib/ssh';
import type { LocalSshAgent, SshClient } from '../lib/ssh';
import { waitFor } from '../lib/wait-for';

// ssh-agent forwarding (docs/guides/ssh.md): the agent on this machine signs
// a git push made in the imp, and the key never reaches the imp. The git
// server runs on this machine; the imp reaches it through NAT.

const prefix = setupSuite('ssh-agent');
const name = `${prefix}a`;
let client: SshClient;
let laptop: LocalSshAgent;
let git: GitSshServer;
let gateway: string;

beforeAll(async () => {
  client = await setupSshClient();
  laptop = await startLocalSshAgent(client);
  gateway = await readContainerGateway();
  git = await startGitSshServer(gateway, client.dir, laptop.publicKey);

  await createImp(name, '--image', resolveImageName('e2e-git'), '--memory', '256');
}, 120_000);

afterAll(async () => {
  await git[Symbol.asyncDispose]();
  await laptop[Symbol.asyncDispose]();
  await client.cleanup();
});

// `ssh -A box@imp SCRIPT`, with the agent on this machine
function runForwarded(script: string, agentSocket = laptop.socket) {
  return runSsh(client, name, ['-A', script], { env: { SSH_AUTH_SOCK: agentSocket } });
}

function checkExists(path: string): Promise<string> {
  return runShellInImp(name, `if [ -e '${path}' ]; then echo there; else echo gone; fi`);
}

async function waitGone(path: string): Promise<void> {
  await waitFor(`${path} to go`, async () => {
    const state = await checkExists(path);

    if (state !== 'gone') {
      throw new Error(`${path} is still there`);
    }
  });
}

test('ssh -A lists the laptop key, from a socket only the image user owns', async () => {
  const result = await runForwarded(
    'ssh-add -l; stat -c "%U %a" "$SSH_AUTH_SOCK" "$(dirname "$SSH_AUTH_SOCK")"',
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('imp-e2e-laptop (ED25519)');
  expect(result.stdout).toContain('dev 600\ndev 700\n');
});

test('a git push from the imp is signed by the laptop agent', async () => {
  const knownHost = `[${gateway}]:${String(git.port)} ${git.hostKey}`;
  const remote = `ssh://git@${gateway}:${String(git.port)}/repo.git`;

  const result = await runForwarded(
    [
      'set -e',
      'mkdir -p ~/.ssh',
      `echo '${knownHost}' > ~/.ssh/known_hosts`,
      'cd "$(mktemp -d)"',
      'git init -q -b main',
      'git -c user.email=e2e@imp -c user.name=e2e commit -q --allow-empty -m signed-by-agent',
      `GIT_SSH_COMMAND='ssh -o BatchMode=yes' git push -q ${remote} main`,
      'ls -A ~/.ssh',
    ].join('\n'),
  );

  expect(result).toMatchObject({ exitCode: 0, stdout: 'known_hosts\n' });
  expect(git.logins()).toBeGreaterThan(0);

  const pushed = await runChecked(['git', '--git-dir', git.repo, 'log', '--format=%s', 'main']);

  expect(pushed.trim()).toBe('signed-by-agent');
});

test('only the image user and root reach the socket', async () => {
  const result = await runForwarded(
    [
      'S=$SSH_AUTH_SOCK',
      'sudo setpriv --reuid=65534 --regid=65534 --clear-groups env SSH_AUTH_SOCK="$S" ssh-add -l 2>/dev/null',
      'echo "nobody=$?"',
      'sudo env SSH_AUTH_SOCK="$S" ssh-add -l >/dev/null',
      'echo "root=$?"',
    ].join('\n'),
  );

  // ssh-add exits 2 when it cannot reach the agent
  expect(result.stdout).toContain('nobody=2\n');
  expect(result.stdout).toContain('root=0\n');
});

test('without an agent on this machine, ssh-add in the imp fails at once', async () => {
  const result = await runForwarded(
    'start=$(date +%s); ssh-add -l; echo "code=$? seconds=$(( $(date +%s) - start ))"',
    join(client.dir, 'no-agent.sock'),
  );

  const [, code, seconds] = /code=(?<code>\d+) seconds=(?<seconds>\d+)/.exec(result.stdout) ?? [];

  expect(Number(code)).not.toBe(0);
  expect(Number(seconds)).toBeLessThan(3);
});

test('the socket goes when the connection ends', async () => {
  const result = await runForwarded('echo "$SSH_AUTH_SOCK"');

  const socket = result.stdout.trim();

  expect(socket).toStartWith('/run/imp/ssh-agent/');

  await waitGone(dirname(socket));
});

// A forced sleep resets the agent connections: the guest drops the socket,
// and the connection's next session gets a new one that works.
test('a forced sleep ends the socket, and the next session listens again', async () => {
  const control = join(client.dir, 'control');
  const env = { SSH_AUTH_SOCK: laptop.socket };
  const muxArgs = [...client.configArgs, '-A', '-S', control, `${name}@${SSH_HOST}`];

  const master = startSsh(
    client,
    ['-A', '-M', '-S', control, '-N', `${name}@${SSH_HOST}`],
    undefined,
    env,
  );

  try {
    await waitFor('the control socket', () => runChecked(['test', '-S', control]));

    const before = await runCommand(['ssh', ...muxArgs, 'echo "$SSH_AUTH_SOCK"'], { env });

    const first = before.stdout.trim();

    await runImp('sleep', name);

    const after = await runCommand(['ssh', ...muxArgs, 'echo "$SSH_AUTH_SOCK"; ssh-add -l'], {
      env,
    });

    const [second = ''] = after.stdout.split('\n');

    expect(second).not.toBe(first);
    expect(after.stdout).toContain('imp-e2e-laptop (ED25519)');

    await waitGone(dirname(first));
  } finally {
    await master.stop();
  }
});

// The private key as its file holds it (the base64 line with the private
// half) and as an agent holds it in memory: the ed25519 seed. grep matches
// within lines, so the seed pattern is its longest run without a newline.
function readKeyPatterns(keyPath: string): { readonly text: string; readonly seedHex: string } {
  const file = readFileSync(keyPath, 'utf8');
  const parsed = utils.parseKey(file);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const der = createPrivateKey(parsed.getPrivatePEM()).export({ type: 'pkcs8', format: 'der' });

  const runs = [...der.subarray(-32)]
    .map((byte) => (byte === 10 ? '|' : `\\x${byte.toString(16).padStart(2, '0')}`))
    .join('')
    .split('|');

  const seedHex = runs.toSorted((a, b) => b.length - a.length)[0] ?? '';

  return { text: file.split('\n')[3] ?? '', seedHex };
}

// Matches of the file line and of the seed, and whether a control that must
// be there was found. The disk and the memory file are sparse (a 32 GiB disk
// holds megabytes); tar reads only their data.
async function countMatches(
  path: string,
  patterns: ReturnType<typeof readKeyPatterns>,
  control: string,
) {
  const count = async (flag: '-F' | '-P', pattern: string): Promise<string> => {
    // LC_ALL=C: -P matches bytes, not UTF-8 characters
    const script =
      'tar -cS -f - -C "$(dirname "$1")" "$(basename "$1")" | LC_ALL=C grep -c -a "$2" "$3"';

    const result = await runInContainer(['sh', '-c', script, 'sh', path, flag, pattern]);

    return result.stdout.trim();
  };

  const found = await count('-F', control);
  const text = await count('-F', patterns.text);
  const seed = await count('-P', patterns.seedHex);

  return { control: Number(found) > 0, text, seed };
}

test('the key never reaches the imp: not its disk, not its slept memory', async () => {
  const imp = await requireImp(name);

  const patterns = readKeyPatterns(laptop.keyPath);

  await runImp('sleep', name);

  const dir = `/var/lib/imp/imps/${imp.id}`;

  const inMemory = await countMatches(`${dir}/snapshot/mem`, patterns, 'Linux version');
  const onDisk = await countMatches(`${dir}/disk.ext4`, patterns, 'dev:x:1000:');

  const none = { control: true, text: '0', seed: '0' };

  expect({ inMemory, onDisk }).toEqual({ inMemory: none, onDisk: none });
});
