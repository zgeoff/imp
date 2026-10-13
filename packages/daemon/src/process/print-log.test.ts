import { expect, onTestFinished, test } from 'bun:test';
import { resetSync } from '@logtape/logtape';
import { parseLegacyLine, printLog } from './print-log';
import { setupLogging } from './setup-logging';
import { withImpLogContext } from './with-imp-log-context';

function setupTest() {
  const lines: string[] = [];

  setupLogging((line) => {
    lines.push(line);
  });

  onTestFinished(() => {
    resetSync();
  });

  return { lines };
}

test('#printLog writes an area line with its level and category, its text unchanged', () => {
  const ctx = setupTest();

  printLog('impd: ipv6: fd00::/64, NAT66 via eth0');

  expect(ctx.lines).toStrictEqual(['INFO impd.ipv6 impd: ipv6: fd00::/64, NAT66 via eth0\n']);
});

test('#printLog writes a line about one imp with the imp', () => {
  const ctx = setupTest();

  printLog('impd: web: asleep in 120ms');

  expect(ctx.lines).toStrictEqual(['INFO impd.imps imp=web impd: web: asleep in 120ms\n']);
});

test('#printLog writes the imp of the context an area line is written in', () => {
  const ctx = setupTest();

  withImpLogContext('web', () => {
    printLog('impd: move: sent the disk');
  });

  expect(ctx.lines).toStrictEqual(['INFO impd.move imp=web impd: move: sent the disk\n']);
});

test('#printLog writes braces in the text as they are', () => {
  const ctx = setupTest();

  printLog('impd: backup: unknown egress policy {"x":1}; restored as none');

  expect(ctx.lines).toStrictEqual([
    'INFO impd.backup impd: backup: unknown egress policy {"x":1}; restored as none\n',
  ]);
});

test('#printLog writes the bare line to stdout in a process that never set up logging', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import { printLog } from './print-log'; printLog('impd: gc: removed 2 drives');`,
    ],
    { cwd: import.meta.dir, stdout: 'pipe' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const stdout = await new Response(child.stdout).text();

  expect(stdout).toBe('impd: gc: removed 2 drives\n');
});

test.each<[string, ReturnType<typeof parseLegacyLine>]>([
  ['impd: broker: kept secret value file a', { area: 'broker', imp: undefined, level: 'info' }],
  ['impd: web: booted pid 42', { area: 'imps', imp: 'web', level: 'info' }],
  ['impd: boot template abc built in 3ms', { area: 'boot', imp: undefined, level: 'info' }],
  ['impd: removed 3 drives', { area: undefined, imp: undefined, level: 'info' }],
  ['imp-docker-proxy on /run/x.sock', { area: undefined, imp: undefined, level: 'info' }],
  [
    'impd: https: warning: tailscale serve holds 443',
    { area: 'https', imp: undefined, level: 'warning' },
  ],
  [
    'impd: egress: WARNING: a public imp exists',
    { area: 'egress', imp: undefined, level: 'warning' },
  ],
  ['impd: web: the watchdog restart failed: x', { area: 'imps', imp: 'web', level: 'warning' }],
  ['impd: web: cannot adopt the VM a wake left', { area: 'imps', imp: 'web', level: 'warning' }],
  ['impd: ssh: not started on :22: refused', { area: 'ssh', imp: undefined, level: 'warning' }],
  ['impd: stop: imps could not stop', { area: 'stop', imp: undefined, level: 'warning' }],
  [
    'impd: image build: ERROR: builder b survives',
    { area: 'image', imp: undefined, level: 'error' },
  ],
  ['impd: egress: NO FIREWALL: nft is missing', { area: 'egress', imp: undefined, level: 'error' }],
])('#parseLegacyLine reads %s', (message, expected) => {
  expect(parseLegacyLine(message)).toStrictEqual(expected);
});
