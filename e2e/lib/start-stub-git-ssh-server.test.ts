import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitCommand } from './git-env';
import { runCommand } from './instance';
import { startStubGitSshServer } from './start-stub-git-ssh-server';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-git-ssh-test-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // a commit to push, made the way a user's checkout would hold one
  const work = join(dir, 'work');

  const gitEnv = {
    GIT_AUTHOR_NAME: 'e2e',
    GIT_AUTHOR_EMAIL: 'e2e@imp.test',
    GIT_COMMITTER_NAME: 'e2e',
    GIT_COMMITTER_EMAIL: 'e2e@imp.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };

  await runGitCommand(['git', 'init', '-q', '-b', 'main', work], { env: gitEnv });
  await writeFile(join(work, 'README'), 'pushed\n');
  await runGitCommand(['git', '-C', work, 'add', 'README'], { env: gitEnv });
  await runGitCommand(['git', '-C', work, 'commit', '-q', '-m', 'first'], { env: gitEnv });

  const head = await runGitCommand(['git', '-C', work, 'rev-parse', 'main'], { env: gitEnv });

  return { dir, work, gitEnv, head: head.stdout.trim() };
}

test('it lands a push signed by the key it allows, from a client that checks its host key', async () => {
  const ctx = await setupTest();

  await runCommand(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(ctx.dir, 'laptop')]);

  const allowed = await readFile(join(ctx.dir, 'laptop.pub'), 'utf8');
  const server = await startStubGitSshServer('127.0.0.1', ctx.dir, allowed);

  onTestFinished(() => server.stop());

  const knownHosts = join(ctx.dir, 'known_hosts');

  await writeFile(knownHosts, `[127.0.0.1]:${String(server.port)} ${server.hostKey}\n`);

  const push = await runGitCommand(
    [
      'git',
      '-C',
      ctx.work,
      'push',
      '-q',
      `ssh://git@127.0.0.1:${String(server.port)}/repo.git`,
      'main',
    ],
    {
      env: {
        ...ctx.gitEnv,
        SSH_AUTH_SOCK: '',
        GIT_SSH_COMMAND: `ssh -F /dev/null -i ${join(ctx.dir, 'laptop')} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o LogLevel=ERROR -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`,
      },
    },
  );

  const landed = await runGitCommand(['git', '-C', server.repo, 'rev-parse', 'main']);

  expect(push.exitCode).toBe(0);
  expect(landed.stdout.trim()).toBe(ctx.head);
  expect(server.logins()).toBe(1);
});

test('it refuses a key other than the one it allows', async () => {
  const ctx = await setupTest();

  await runCommand(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(ctx.dir, 'laptop')]);
  await runCommand(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(ctx.dir, 'other')]);

  const allowed = await readFile(join(ctx.dir, 'laptop.pub'), 'utf8');
  const server = await startStubGitSshServer('127.0.0.1', ctx.dir, allowed);

  onTestFinished(() => server.stop());

  const knownHosts = join(ctx.dir, 'known_hosts');

  await writeFile(knownHosts, `[127.0.0.1]:${String(server.port)} ${server.hostKey}\n`);

  const push = await runGitCommand(
    [
      'git',
      '-C',
      ctx.work,
      'push',
      '-q',
      `ssh://git@127.0.0.1:${String(server.port)}/repo.git`,
      'main',
    ],
    {
      env: {
        ...ctx.gitEnv,
        SSH_AUTH_SOCK: '',
        GIT_SSH_COMMAND: `ssh -F /dev/null -i ${join(ctx.dir, 'other')} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o LogLevel=ERROR -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`,
      },
    },
  );

  const landed = await runGitCommand([
    'git',
    '-C',
    server.repo,
    'rev-parse',
    '--verify',
    '--quiet',
    'main',
  ]);

  expect(push.exitCode).toBe(128);
  expect(push.stderr).toInclude('Permission denied (publickey)');
  expect(landed.exitCode).toBe(1);
  expect(server.logins()).toBe(0);
});

test('it refuses a command other than a push to repo.git', async () => {
  const ctx = await setupTest();

  await runCommand(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(ctx.dir, 'laptop')]);

  const allowed = await readFile(join(ctx.dir, 'laptop.pub'), 'utf8');
  const server = await startStubGitSshServer('127.0.0.1', ctx.dir, allowed);

  onTestFinished(() => server.stop());

  const knownHosts = join(ctx.dir, 'known_hosts');

  await writeFile(knownHosts, `[127.0.0.1]:${String(server.port)} ${server.hostKey}\n`);

  const fetched = await runCommand(
    [
      'ssh',
      '-F',
      '/dev/null',
      '-i',
      join(ctx.dir, 'laptop'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-p',
      String(server.port),
      'git@127.0.0.1',
      "git-upload-pack '/repo.git'",
    ],
    { env: { SSH_AUTH_SOCK: '' } },
  );

  expect(fetched).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "only git push to repo.git: git-upload-pack '/repo.git'\n",
  });
});
