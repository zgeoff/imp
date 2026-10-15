import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { runCommand } from './instance';
import { listAgentThroughUnixForward, startLocalSshAgent } from './ssh';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#listAgentThroughUnixForward lists the agent at the far end of the forward, and removes the local socket', async () => {
  const ctx = await setupTest();

  // ssh that serves its -L listen path with an empty agent of its own, as
  // the forward to an agent in the imp would
  const ssh = createStubBin(
    ctx.dir,
    'ssh',
    [
      'for arg in "$@"; do',
      '  if [ "$prev" = -L ]; then spec=$arg; fi',
      '  prev=$arg',
      'done',
      'echo "forward $spec" >&2',
      String.raw`exec ssh-agent -D -a "$(printf '%s' "$spec" | cut -d: -f1)" >/dev/null 2>&1`,
    ].join('\n'),
  );

  updateEnv('PATH', `${ssh.bin}:${process.env['PATH'] ?? ''}`);

  const local = join(ctx.dir, 'dev.sock');

  const forwarded = await listAgentThroughUnixForward(
    { configArgs: ['-F', join(ctx.dir, 'config')], dir: ctx.dir, cleanup: () => Promise.resolve() },
    'e2e-sa-unix',
    '/tmp/e2e-dev.sock',
    local,
  );

  expect(forwarded).toStrictEqual({
    listed: { exitCode: 1, stdout: 'The agent has no identities.\n', stderr: '' },
    forwardLog: `forward ${local}:/tmp/e2e-dev.sock\n`,
  });

  expect(existsSync(local)).toBeFalse();
});

test('#startLocalSshAgent serves the key it made until stop, which removes its socket', async () => {
  const ctx = await setupTest();

  const agent = await startLocalSshAgent(
    { configArgs: [], dir: ctx.dir, cleanup: () => Promise.resolve() },
    'unit',
  );

  onTestFinished(() => agent.stop());

  const listed = await runCommand(['ssh-add', '-L'], { env: { SSH_AUTH_SOCK: agent.socket } });

  await agent.stop();

  expect(listed).toStrictEqual({ exitCode: 0, stdout: agent.publicKey, stderr: '' });
  expect(agent.publicKey).toEndWith(' imp-e2e-unit\n');
  expect(existsSync(agent.socket)).toBeFalse();
});

test('#startLocalSshAgent stops again without an error once it has stopped', async () => {
  const ctx = await setupTest();

  const agent = await startLocalSshAgent(
    { configArgs: [], dir: ctx.dir, cleanup: () => Promise.resolve() },
    'unit',
  );

  onTestFinished(() => agent.stop());

  await agent.stop();

  await expect(agent.stop()).toResolve();
});
