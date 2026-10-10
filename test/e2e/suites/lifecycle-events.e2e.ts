import { expect, onTestFinished, test } from 'bun:test';
import * as z from 'zod';
import { config } from '../lib/config';
import { collectEventLines } from '../lib/event-lines';
import { createInstanceClient, runImp, startImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// `imp events` (docs/guides/events.md) and the api audit log, over one imp's
// create, sleep, wake and rm.

// one stack for every release, so the event stream ends before its imps go
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('lifecycle'), stack, client };
}

test('it streams a create, sleep, wake and rm as events with no reconnect, and logs each call in the api audit log', async () => {
  const ctx = await setupTest();

  const anchor = `${ctx.prefix}anchor`;
  const name = `${ctx.prefix}ev`;

  // an imp already there, whose snapshot line says the stream is open
  await runImp('new', anchor, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, anchor));

  await waitForExec(anchor);

  const events = await startImp(['events']);

  const seen: string[] = [];

  const collecting = collectEventLines(events.stdout, (line) => {
    seen.push(line);
  });

  ctx.stack.defer(async () => {
    events.kill();

    await collecting;
  });

  await waitFor('the snapshot from imp events', () => {
    expect(seen).toContain(`${anchor} ImpAdded snapshot running`);
  });

  const startedAt = new Date();

  await runImp('new', name, '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await runImp('sleep', name);
  await runImp('wake', name);
  await runImp('rm', name);

  await waitFor('the rm in imp events', () => {
    expect(seen).toContain(`${name} ImpRemoved`);
  });

  events.kill();

  await collecting;

  // a reconnect says why on stderr, and its snapshot would stand in for the
  // changes it missed
  const warnings = await new Response(events.stderr).text();

  const lines = seen.filter((line) => line.startsWith(`${name} `));

  expect(warnings).toBe('');

  expect(lines).toStrictEqual([
    `${name} ImpAdded created`,
    `${name} ImpChanged booted`,
    `${name} ImpChanged slept`,
    `${name} ImpChanged woke`,
    `${name} ImpRemoved`,
  ]);

  const audit = await runImp('audit', name, '--kind', 'api', '--json');

  // a reused dev instance keeps the rows of earlier runs: only this run's count
  const calls = z
    .array(z.object({ at: z.coerce.date(), procedure: z.string(), actor: z.string() }))
    .parse(JSON.parse(audit))
    .filter((call) => call.at >= startedAt);

  expect(calls.map((call) => call.procedure)).toStrictEqual([
    'imps.destroy',
    'imps.wake',
    'imps.sleep',
    'imps.create',
  ]);

  expect(calls.map((call) => call.actor)).toStrictEqual(['token', 'token', 'token', 'token']);
});
