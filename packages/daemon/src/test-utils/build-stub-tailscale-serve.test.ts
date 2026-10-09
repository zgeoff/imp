import { expect, test } from 'bun:test';
import { buildStubTailscaleServe } from './build-stub-tailscale-serve';

test('it prints nothing for serve status while nothing is served', async () => {
  const serve = buildStubTailscaleServe();

  const result = await serve.run(['tailscale', 'serve', 'status', '--json']);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
});

test('it reports a service written on both ports as tailscale serve status does', async () => {
  const serve = buildStubTailscaleServe({ tailnet: 'tail9.ts.net' });

  await serve.run(['tailscale', 'serve', '--service=svc:dev', '--http=80', 'http://10.0.0.2:80']);
  await serve.run(['tailscale', 'serve', '--service=svc:dev', '--https=443', 'http://10.0.0.2:80']);

  const status = await serve.runChecked(['tailscale', 'serve', 'status', '--json']);

  expect(JSON.parse(status)).toStrictEqual({
    Services: {
      'svc:dev': {
        TCP: { '80': { HTTP: true }, '443': { HTTPS: true } },
        Web: {
          'dev.tail9.ts.net:80': { Handlers: { '/': { Proxy: 'http://10.0.0.2:80' } } },
          'dev.tail9.ts.net:443': { Handlers: { '/': { Proxy: 'http://10.0.0.2:80' } } },
        },
      },
    },
  });
});

test('it drops a service from the status once it is cleared', async () => {
  const serve = buildStubTailscaleServe();

  await serve.run(['tailscale', 'serve', '--service=svc:dev', '--http=80', 'http://10.0.0.2:80']);
  await serve.run(['tailscale', 'serve', 'clear', 'svc:dev']);

  const status = await serve.runChecked(['tailscale', 'serve', 'status', '--json']);

  expect(status).toBe('');
});

test('it lists node-level ports it holds under TCP', async () => {
  const serve = buildStubTailscaleServe();

  serve.holdPort(443);

  const status = await serve.runChecked(['tailscale', 'serve', 'status', '--json']);

  expect(status).toBe('{"TCP":{"443":{"HTTPS":true}}}');
});

test('it exits 1 for a command it does not model', async () => {
  const serve = buildStubTailscaleServe();

  const result = await serve.run(['tailscale', 'serve', 'reset']);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'unknown command: tailscale serve reset',
  });
});

test('it fails only the next call after failNext', async () => {
  const serve = buildStubTailscaleServe();

  serve.failNext('tailscaled is not running');

  const failed = await serve.run(['tailscale', 'serve', 'status', '--json']);
  const next = await serve.run(['tailscale', 'serve', 'status', '--json']);

  expect(failed).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'tailscaled is not running' });
  expect(next.exitCode).toBe(0);
});

test('it throws the stderr from runChecked on a non-zero exit', () => {
  const serve = buildStubTailscaleServe();

  serve.failNext('tailscaled is not running');

  expect(serve.runChecked(['tailscale', 'serve', 'status', '--json'])).rejects.toThrowWithMessage(
    Error,
    'tailscale serve status --json exited 1: tailscaled is not running',
  );
});

test('it records every argv in order', async () => {
  const serve = buildStubTailscaleServe();

  await serve.run(['tailscale', 'serve', 'status', '--json']);
  await serve.runChecked(['tailscale', 'serve', 'clear', 'svc:dev']);

  expect(serve.calls).toStrictEqual([
    ['tailscale', 'serve', 'status', '--json'],
    ['tailscale', 'serve', 'clear', 'svc:dev'],
  ]);
});
