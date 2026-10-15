import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runInImp, startImp, tryImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeTokenIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { startTextCapture } from '../lib/text-capture';
import { waitFor } from '../lib/wait-for';

// `impz exec --agent` (docs/architecture/guest/agent.md#execs-and-services): a root shell
// beside the inner container, in the agent's own 32 MiB cgroup.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('inner'), stack, client };
}

test('it runs exec --agent as root outside the container and reports it as an AgentExec event', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}agent`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const events = await startImp(['events', name]);

  ctx.stack.defer(async () => {
    events.kill();

    await events.exited;
  });

  const seen = startTextCapture(events.stdout);

  // the shell computes the line, so the terminal's echo of the input does
  // not match it
  const shell = await tryImp(['exec', '--agent', '-t', name, '--', 'sh'], {
    stdin: 'echo outer-$((20 + 22)) $(id -u) $(cat /proc/self/oom_score_adj)\nexit\n',
  });

  const cgroup = await runImp('exec', '--agent', name, '--', 'cat', '/proc/self/cgroup');
  const container = await runInImp(name, 'cat', '/proc/self/cgroup');

  await waitFor('the AgentExec event', () => {
    expect(seen.read()).toContain('"ev":"AgentExec"');
  });

  expect(shell).toStrictEqual({
    exitCode: 0,
    stdout: expect.toInclude('outer-42 0 0'),
    stderr: expect.toBeString(),
  });

  expect(cgroup.trim()).toMatch(/^0::\/outer\/\d+$/);
  expect(container.trim()).not.toContain('outer');
});

test('it refuses exec --agent to an exec-scoped token', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}exectok`;
  const token = `${ctx.prefix}exec`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const secret = await runImp('token', 'new', token, '--scope', 'exec');

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, token));

  const refused = await tryImp(['exec', '--agent', name, '--', 'true'], { token: secret.trim() });

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });
});

test('it refuses exec --agent to a manage token scoped to the one imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}imptok`;
  const token = `${ctx.prefix}manage`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const secret = await runImp('token', 'new', token, '--scope', 'manage', '--imps', name);

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, token));

  const refused = await tryImp(['exec', '--agent', name, '--', 'true'], { token: secret.trim() });

  expect(refused).toStrictEqual({
    exitCode: 255,
    stdout: '',
    stderr: expect.toInclude('FORBIDDEN'),
  });
});

test('it lets a memory hog outside the container meet the OOM killer in its 32 MiB', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}outoom`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const hog = await tryImp([
    'exec',
    '--agent',
    name,
    '--',
    'awk',
    'BEGIN { s = "x"; while (1) s = s s }',
  ]);

  const events = await runImp(
    'exec',
    '--agent',
    name,
    '--',
    'cat',
    '/sys/fs/cgroup/outer/memory.events',
  );

  const answered = await tryImp(['exec', name, '--', 'true']);

  const kills = Number(/^oom_kill (?<count>\d+)$/m.exec(events)?.groups?.['count']);

  expect(hog.exitCode).toBe(137);
  expect(kills).toBeGreaterThan(0);
  expect(answered.exitCode).toBe(0);
});
