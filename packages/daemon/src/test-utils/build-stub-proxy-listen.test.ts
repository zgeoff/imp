import { expect, onTestFinished, test } from 'bun:test';
import { buildMockCertificate } from './build-mock-certificate';
import { buildStubProxyListen } from './build-stub-proxy-listen';

test('it answers a request with the address it listens on', async () => {
  const proxy = buildStubProxyListen();

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  onTestFinished(() => listener.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);
  const body = await response.text();

  expect(body).toBe('served on 127.0.0.1');
});

test('it serves the TLS certificate it is given', async () => {
  const proxy = buildStubProxyListen();

  const certificate = await buildMockCertificate({ names: ['imp.test'] });

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    tls: { key: certificate.keyPem, cert: certificate.chainPem },
    route: () => ({ kind: 'api' }),
  });

  onTestFinished(() => listener.stop(true));

  const response = await fetch(`https://127.0.0.1:${String(listener.port)}/`, {
    tls: { rejectUnauthorized: false },
  });

  const body = await response.text();

  expect(body).toBe('served on 127.0.0.1');
});

test('it runs the route a listener is given for each request', async () => {
  const proxy = buildStubProxyListen();

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => Promise.resolve({ kind: 'none', hint: 'no imp here' }),
  });

  onTestFinished(() => listener.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);

  await response.text();

  expect(response.headers.get('x-route')).toBe('none');
  expect(proxy.routes).toStrictEqual(['none']);
});

test('it lets a second listener that asks for reusePort share the first one’s port', () => {
  const proxy = buildStubProxyListen();

  const first = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    reusePort: true,
    route: () => ({ kind: 'api' }),
  });

  onTestFinished(() => first.stop(true));

  const second = proxy.startListener({
    port: first.port ?? 0,
    hostname: '127.0.0.1',
    reusePort: true,
    route: () => ({ kind: 'api' }),
  });

  onTestFinished(() => second.stop(true));

  expect(second.port).toBe(first.port);
});

test('it refuses a second listener on a taken port when neither asks for reusePort', () => {
  const proxy = buildStubProxyListen();

  const first = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  onTestFinished(() => first.stop(true));

  expect(() =>
    proxy.startListener({
      port: first.port ?? 0,
      hostname: '127.0.0.1',
      route: () => ({ kind: 'api' }),
    }),
  ).toThrow(expect.objectContaining({ code: 'EADDRINUSE' }));
});

test('it records each start and stop with its address', async () => {
  const proxy = buildStubProxyListen();

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  onTestFinished(() => listener.stop(true));

  await listener.stop(true);

  expect(proxy.events).toStrictEqual(['start 127.0.0.1', 'stop 127.0.0.1']);
});
