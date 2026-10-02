import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startFakeImpd } from './fake-impd';
import type { FakeImpd, FakeImpdPeer, FakeImpdReceived } from './fake-impd';

// Signals and process.exit need a process of their own: these run the CLI.

const MAIN = join(import.meta.dir, 'main.ts');

// a cold bun start on a loaded machine can take seconds
const SUBPROCESS_TIMEOUT_MS = 20_000;

function startExec(impd: Pick<FakeImpd, 'token' | 'url'>) {
  return Bun.spawn(['bun', MAIN, 'exec', 'box', '--', 'sleep', '60'], {
    env: { ...process.env, IMP_URL: impd.url, IMP_TOKEN: impd.token },
    stdin: 'ignore',
    stderr: 'pipe',
  });
}

function hasStart(received: readonly FakeImpdReceived[]): boolean {
  return received.some((message) => message['type'] === 'start');
}

function hasSignal(received: readonly FakeImpdReceived[]): boolean {
  return received.some((message) => message['type'] === 'signal');
}

test(
  'a signal before started ends the session at once, without forwarding it',
  async () => {
    // impd never answers the start, as when it hangs waking the imp
    await using impd = startFakeImpd(() => {});

    const cli = startExec(impd);

    await impd.waitFor(hasStart);

    cli.kill('SIGTERM');

    const exitCode = await cli.exited;

    expect(exitCode).toBe(143);
    expect(impd.received.filter((message) => message['type'] === 'signal')).toEqual([]);
  },
  SUBPROCESS_TIMEOUT_MS,
);

test(
  'after started, the first SIGINT goes to the command and the second ends the session',
  async () => {
    // the command ignores SIGINT, so only the second one ends anything
    await using impd = startFakeImpd((peer: FakeImpdPeer, message) => {
      if (message['type'] === 'start') {
        peer.send({ type: 'started', pid: 7 });
      }
    });

    const cli = startExec(impd);

    // stdin is /dev/null, so stdin_eof follows started
    await impd.waitFor((received) => received.some((message) => message['type'] === 'stdin_eof'));

    cli.kill('SIGINT');

    await impd.waitFor(hasSignal);

    cli.kill('SIGINT');

    const exitCode = await cli.exited;

    expect(exitCode).toBe(130);

    expect(impd.received.filter((message) => message['type'] === 'signal')).toEqual([
      { type: 'signal', signal: 'SIGINT' },
    ]);
  },
  SUBPROCESS_TIMEOUT_MS,
);

test(
  'process.exit inside the message handler still takes the terminal out of raw mode',
  async () => {
    await using impd = startFakeImpd((peer, message) => {
      if (message['type'] === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.sendFrame(1, 'out');
      }
    });

    // a fake terminal on stdin that logs its mode, and output that exits
    const script = `
    import { PassThrough } from 'node:stream';
    import { runExec } from ${JSON.stringify(join(import.meta.dir, 'exec-client.ts'))};

    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (mode) => console.error('raw ' + mode),
    });

    await runExec({ host: null, name: 'box', argv: ['sh'], tty: true }, {
      env: process.env,
      stdin,
      writeOutput: () => process.exit(3),
    });
  `;

    const cli = Bun.spawn(['bun', '-e', script], {
      env: { ...process.env, IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: 'ignore',
      stderr: 'pipe',
    });

    const exitCode = await cli.exited;

    const stderr = await new Response(cli.stderr).text();

    expect(exitCode).toBe(3);
    expect(stderr).toBe('raw true\nraw false\n');
  },
  SUBPROCESS_TIMEOUT_MS,
);
