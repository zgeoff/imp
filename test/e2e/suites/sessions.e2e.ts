import { expect, test } from 'bun:test';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, readState, requireImp, runImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { openTerminal } from '../lib/terminal';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('sessions');
const BARE = resolveImageName('e2e-bare');
const name = `${prefix}a`;

// the idle timeout plus a sweep of the idle loop
const ASLEEP_WITHIN_MS = (config.idleTimeoutS + 15) * 1000;

// long enough that only activity keeps an imp awake
const PAST_IDLE_MS = (config.idleTimeoutS + 6) * 1000;
const DETACH_KEY = '\u001D';

// the CLI's exit code once another terminal took the session over
const TAKEN_OVER_CODE = 254;

// prints the terminal size on SIGWINCH, on the main screen
const DRAW_PROGRAM = String.raw`sh -c 'trap "echo size=\$(stty size)" WINCH; echo drawn; while :; do sleep 0.2; done'`;

const SessionRowSchema = z.object({
  name: z.string(),
  pid: z.number(),
  state: z.string(),
  attached: z.boolean(),
  cols: z.number(),
  rows: z.number(),
});

async function listSessions(imp: string) {
  const stdout = await runImp('sessions', imp, '--json');

  return z.array(SessionRowSchema).parse(JSON.parse(stdout));
}

async function requireSession(imp: string, session: string) {
  const sessions = await listSessions(imp);

  const found = sessions.find((row) => row.name === session);

  if (found === undefined) {
    throw new Error(`no session ${session} in ${imp}: ${JSON.stringify(sessions)}`);
  }

  return found;
}

function countText(output: string, text: string): number {
  return output.split(text).length - 1;
}

function waitAsleep(imp: string): Promise<void> {
  return waitFor(`${imp} to sleep`, () => assertState(imp, 'sleeping'), {
    timeoutMs: ASLEEP_WITHIN_MS,
  });
}

const state = { pid: 0 };

test('imp console starts a session that a detach key leaves running', async () => {
  await createImp(name, '--image', BARE, '--memory', '256');

  const terminal = await openTerminal(['console', name]);

  await terminal.waitForText('# ');

  terminal.type('echo marker-$((6*7))\n');

  await terminal.waitForText('marker-42');

  terminal.type(DETACH_KEY);

  const exitCode = await terminal.exited;
  const session = await requireSession(name, 'main');

  state.pid = session.pid;

  expect(exitCode).toBe(0);
  expect(terminal.readOutput()).toContain(`detached from session main (imp attach ${name} main)`);
  expect(session).toMatchObject({ state: 'running', attached: false, cols: 80, rows: 24 });
});

test('a detached idle session lets the imp sleep, and a list does not wake it', async () => {
  await waitAsleep(name);

  const session = await requireSession(name, 'main');
  const imp = await requireImp(name);

  expect(session.pid).toBe(state.pid);
  expect(imp.state).toBe('sleeping');
  expect(imp.sessions).toBe(1);
});

test('imp attach wakes the imp and shows the session, which redraws at the new size', async () => {
  const terminal = await openTerminal(['attach', name], { cols: 100, rows: 30 });

  await terminal.waitForText('marker-42');

  const replayed = terminal.readOutput().length;

  // a program that draws for the terminal's size, on the main screen; the
  // shell runs it as the foreground job, which is what SIGWINCH reaches
  terminal.type(`${DRAW_PROGRAM}\n`);

  await terminal.waitForText('drawn', replayed);

  terminal.type(DETACH_KEY);

  const exitCode = await terminal.exited;
  const wide = await openTerminal(['attach', name], { cols: 120, rows: 40 });

  await wide.waitForText('size=40 120');

  const session = await requireSession(name, 'main');

  wide.type(DETACH_KEY);

  await wide.exited;

  expect(exitCode).toBe(0);
  expect(session).toMatchObject({ pid: state.pid, attached: true, cols: 120, rows: 40 });
});

test('a second attach takes the session over', async () => {
  const first = await openTerminal(['attach', name]);

  await first.waitForText('size=24 80');

  const second = await openTerminal(['attach', name]);
  const firstCode = await first.exited;

  // the replay holds the sizes the first terminal saw; the redraw adds one
  const seen = countText(first.readOutput(), 'size=24 80');

  await waitFor('the second terminal to redraw', () => {
    if (countText(second.readOutput(), 'size=24 80') <= seen) {
      throw new Error('no redraw yet');
    }
  });

  const typed = second.readOutput().length;

  second.type('\u0003');
  second.type('echo second-$((2+3))\n');

  await second.waitForText('second-5', typed);

  second.type(DETACH_KEY);

  await second.exited;

  expect(firstCode).toBe(TAKEN_OVER_CODE);
  expect(first.readOutput()).toContain('another client attached to session main');
});

test('an attached terminal survives imp sleep by attaching again', async () => {
  const terminal = await openTerminal(['attach', name]);

  // the replay has a prompt already; new output shows the attach is live
  terminal.type('echo live-$((3+4))\n');

  await terminal.waitForText('live-7');

  await runImp('sleep', name);

  await terminal.waitForText('attaching again');

  // typed while it attaches again, so the keys wait for the session
  const after = terminal.readOutput().length;

  terminal.type('echo back-$((40+2))\n');

  await terminal.waitForText('attached again', after);
  await terminal.waitForText('back-42', after);

  terminal.type(DETACH_KEY);

  const exitCode = await terminal.exited;
  const session = await requireSession(name, 'main');

  expect(exitCode).toBe(0);
  expect(session.pid).toBe(state.pid);
});

test('a busy detached session keeps the imp awake until it is killed', async () => {
  const terminal = await openTerminal(['console', name, '--session', 'busy']);

  await terminal.waitForText('# ');

  const typed = terminal.readOutput().length;

  terminal.type('echo spin-$((1+1)); while :; do :; done\n');

  // the loop runs once the marker shows
  await terminal.waitForText('spin-2', typed);

  terminal.type(DETACH_KEY);

  await terminal.exited;

  await Bun.sleep(PAST_IDLE_MS);

  const awake = await readState(name);

  await runImp('sessions', 'kill', name, 'busy');

  const sessions = await listSessions(name);

  expect(awake).toBe('running');
  expect(sessions.map((session) => session.name)).toEqual(['main']);

  await waitAsleep(name);
});
