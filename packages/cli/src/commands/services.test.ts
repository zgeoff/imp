import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { runCommand } from 'citty';
import { UsageError } from '../usage-error';
import {
  buildServiceDef,
  createLogPrinter,
  formatLogEvent,
  logsCommand,
  serviceCommand,
} from './services';

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  mock.restore();
  delete process.env['IMP_URL'];
  delete process.env['IMP_TOKEN'];
  process.exitCode = 0;
});

test('--cmd runs through the shell', () => {
  expect(buildServiceDef('web', { cmd: 'node server.js', argv: [] })).toEqual({
    name: 'web',
    argv: ['/bin/sh', '-c', 'node server.js'],
  });
});

test('the words after -- are the argv, and the flags fill the rest', () => {
  const def = buildServiceDef('web', {
    argv: ['busybox', 'httpd', '-f'],
    env: ['PORT=3000', 'MODE=dev'],
    cwd: '/srv',
    user: 'www-data',
    restart: 'on-failure',
  });

  expect(def).toEqual({
    name: 'web',
    argv: ['busybox', 'httpd', '-f'],
    env: ['PORT=3000', 'MODE=dev'],
    cwd: '/srv',
    user: 'www-data',
    restart: 'on-failure',
  });

  expect(buildServiceDef('web', { argv: ['x'], env: 'ONE=1' }).env).toEqual(['ONE=1']);
});

test('a command given twice or not at all, a bad env or restart is a usage error', () => {
  const cases = [
    { argv: [] },
    { cmd: 'a', argv: ['b'] },
    { argv: ['x'], env: 'NOEQUALS' },
    { argv: ['x'], env: ['1X=2'] },
    { argv: ['x'], restart: 'sometimes' },
  ];

  for (const args of cases) {
    expect(() => buildServiceDef('web', args)).toThrow(UsageError);
  }
});

test('with a prefix, each whole line gets its service’s name', () => {
  const written: string[] = [];

  const printer = createLogPrinter(true, (text) => {
    written.push(text);
  });

  printer.print({ type: 'log', service: 'web', text: 'GET /\nGET /a' });
  printer.print({ type: 'log', service: 'db', text: 'ready\n' });
  printer.print({ type: 'log', service: 'web', text: 'bc\n' });
  printer.print({ type: 'log', service: 'db', text: 'tail with no end' });
  printer.flush();

  expect(written).toEqual([
    'web | GET /\n',
    'db | ready\n',
    'web | GET /abc\n',
    'db | tail with no end\n',
  ]);
});

test('a line longer than 64 KiB goes out in pieces, each with the prefix', () => {
  const written: string[] = [];

  const printer = createLogPrinter(true, (text) => {
    written.push(text);
  });

  printer.print({ type: 'log', service: 'web', text: 'x'.repeat(65_536 * 2 + 3) });
  printer.flush();

  expect(written.map((line) => line.length)).toEqual([65_536 + 7, 65_536 + 7, 3 + 7]);
});

test('a follow says when the imp sleeps, runs again, and when impd restarts', () => {
  expect(formatLogEvent('box', { type: 'sleeping', state: 'sleeping' })).toBe(
    'box is sleeping; waiting for it to run (a follow does not wake it)',
  );

  expect(formatLogEvent('box', { type: 'awake' })).toBe('box runs again');
  expect(formatLogEvent('box', { type: 'restarting' })).toBe('impd is restarting; the follow ends');
});

test('without a prefix, text goes out as it comes', () => {
  const written: string[] = [];

  const printer = createLogPrinter(false, (text) => {
    written.push(text);
  });

  printer.print({ type: 'log', service: 'web', text: 'GET' });
  printer.print({ type: 'log', service: 'web', text: ' /\n' });
  printer.flush();

  expect(written).toEqual(['GET', ' /\n']);
});

// An impd that records each call's path and input and answers {} to every
// call, FORBIDDEN to the paths in `refused`, or what `answers` gives.
function startRecordingImpd(
  refused: readonly string[] = [],
  answers: Readonly<Record<string, unknown>> = {},
) {
  const calls: { path: string; input: unknown }[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      const text = await request.text();

      const body: unknown = text === '' ? null : JSON.parse(text);

      const input: unknown =
        body !== null && typeof body === 'object' ? Reflect.get(body, 'json') : null;

      calls.push({ path, input });

      if (refused.includes(path)) {
        const error = { defined: false, code: 'FORBIDDEN', status: 403, message: 'forbidden' };

        return Response.json({ json: error, meta: [] }, { status: 403 });
      }

      return Response.json({ json: answers[path] ?? {}, meta: [] });
    },
  });

  process.env['IMP_URL'] = `http://127.0.0.1:${String(server.port)}`;
  process.env['IMP_TOKEN'] = 'token';

  return {
    calls,
    [Symbol.dispose]: () => {
      void server.stop(true);
    },
  };
}

test('service add sends the definition, with --env given more than once', async () => {
  using impd = startRecordingImpd();

  await runCommand(serviceCommand, {
    rawArgs: ['add', 'box', 'web', '--env', 'A=1', '--env=B=2', '--replace', '--cmd', 'httpd -f'],
  });

  expect(process.exitCode).toBe(0);

  expect(impd.calls).toEqual([
    {
      path: '/rpc/services/add',
      input: {
        name: 'box',
        service: { name: 'web', argv: ['/bin/sh', '-c', 'httpd -f'], env: ['A=1', 'B=2'] },
        replace: true,
      },
    },
  ]);
});

test('service add --http-port adds the service, then sets the port', async () => {
  using impd = startRecordingImpd();

  await runCommand(serviceCommand, {
    rawArgs: ['add', 'box', 'web', '--cmd', 'httpd -f -p 8081', '--http-port', '8081'],
  });

  expect(process.exitCode).toBe(0);
  expect(impd.calls.map((call) => call.path)).toEqual(['/rpc/services/add', '/rpc/imps/update']);
  expect(impd.calls[1]?.input).toEqual({ name: 'box', httpPort: 8081 });
});

test('a refused port says the service runs, and how to set the port', async () => {
  using impd = startRecordingImpd(['/rpc/imps/update']);

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  await runCommand(serviceCommand, {
    rawArgs: ['add', 'box', 'web', '--cmd', 'httpd', '--http-port', '8081'],
  });

  expect(stderr).toHaveBeenCalledWith(
    'imp: service web was added and runs, but the HTTP port was not set: setting the HTTP port needs a token with manage. Run `imp set box --http-port 8081` to set it.',
  );

  expect(process.exitCode).toBe(1);
  expect(impd.calls).toHaveLength(2);
});

test('a bad --http-port fails before any call', async () => {
  using impd = startRecordingImpd();

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  await runCommand(serviceCommand, {
    rawArgs: ['add', 'box', 'web', '--cmd', 'httpd', '--http-port', '70000'],
  });

  expect(stderr).toHaveBeenCalledWith('imp: --http-port must be a port from 1 to 65535');
  expect(process.exitCode).toBe(2);
  expect(impd.calls).toEqual([]);
});

test('ls says when a sleeping imp’s last sleep recorded no list', async () => {
  using impd = startRecordingImpd([], {
    '/rpc/services/list': { services: [], recorded: false },
    '/rpc/imps/get': { state: 'sleeping' },
  });

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  const stdout = spyOn(console, 'log').mockImplementation(() => {
    // captured
  });

  await runCommand(serviceCommand, { rawArgs: ['ls', 'box', '--json'] });

  expect(stderr).toHaveBeenCalledWith(
    'box is sleeping, and its last sleep recorded no services list',
  );

  expect(stdout).toHaveBeenCalledWith('[]');
  expect(impd.calls).toHaveLength(2);
});

test('logs with a bad line count fails before any call', async () => {
  using impd = startRecordingImpd();

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  await runCommand(logsCommand, { rawArgs: ['box', '-n', 'ten'] });

  expect(stderr).toHaveBeenCalledWith('imp: --lines must be a whole number from 0 to 100000');
  expect(process.exitCode).toBe(2);
  expect(impd.calls).toEqual([]);
});
