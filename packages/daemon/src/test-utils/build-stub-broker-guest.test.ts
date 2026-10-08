import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubBrokerGuest } from './build-stub-broker-guest';
import { findFreePorts } from './find-free-ports';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-guest-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  // the CA bundle the guest trusts; no test gets as far as a TLS handshake
  const caFile = join(dir, 'ca.pem');

  await writeFile(caFile, '');

  // a proxy that records the first line and the peer, then refuses
  const seen: { address: string; line: string }[] = [];

  const proxy = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket, data) => {
        seen.push({ address: socket.remoteAddress, line: data.toString().split('\r\n')[0] ?? '' });
        socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      },
    },
  });

  stack.defer(() => {
    proxy.stop(true);
  });

  return { caFile, seen, proxyPort: proxy.port };
}

test('it tunnels through the proxy from the guest address it was given', async () => {
  const ctx = await setupTest();

  const guest = buildStubBrokerGuest({
    proxyPort: ctx.proxyPort,
    caFile: ctx.caFile,
    address: '127.0.0.2',
  });

  await guest.curl('https://api.example.com/x');

  expect(ctx.seen).toStrictEqual([
    { address: '127.0.0.2', line: 'CONNECT api.example.com:443 HTTP/1.1' },
  ]);
});

// curl's exit code and wording for a refused CONNECT differ across
// versions; the status the proxy sent does not
test('it reports the status the proxy refused the CONNECT with', async () => {
  const ctx = await setupTest();

  const guest = buildStubBrokerGuest({
    proxyPort: ctx.proxyPort,
    caFile: ctx.caFile,
    address: '127.0.0.2',
  });

  const result = await guest.curl('https://api.example.com/x', ['-w', '%{http_connect}']);

  expect(result.stdout).toBe('403');
});

test('it reports the exit code and the error curl printed when no proxy listens', async () => {
  const ctx = await setupTest();

  const guest = buildStubBrokerGuest({
    proxyPort: findFreePorts(1).take(),
    caFile: ctx.caFile,
    address: '127.0.0.2',
  });

  const result = await guest.curl('https://api.example.com/x');

  // the text after the code differs across curl versions
  expect(result).toStrictEqual({ code: 7, stdout: '', stderr: expect.toStartWith('curl: (7) ') });
});

test('it passes its extra arguments to curl', async () => {
  const ctx = await setupTest();

  const guest = buildStubBrokerGuest({
    proxyPort: ctx.proxyPort,
    caFile: ctx.caFile,
    address: '127.0.0.2',
  });

  const result = await guest.curl('https://api.example.com/x', ['-w', 'done %{http_code}']);

  expect(result.stdout).toBe('done 000');
});
