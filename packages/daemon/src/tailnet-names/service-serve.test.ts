import { expect, test } from 'bun:test';
import { createServiceServe, listServeEntries, parseServedServices } from './service-serve';

test('it reads each served service as its ports and proxy targets', () => {
  const json = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Services: {
      'svc:box': {
        TCP: { '80': { HTTP: true }, '443': { HTTPS: true } },
        Web: {
          'box.tail1234.ts.net:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } },
          'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:20000' } } },
        },
      },
      'svc:raw': { TCP: { '5432': { TCPForward: '127.0.0.1:5432' } } },
    },
  });

  const served = parseServedServices(json);

  expect([...served.keys()]).toEqual(['svc:box', 'svc:raw']);

  expect([...(served.get('svc:box') ?? [])].toSorted()).toEqual(
    [...listServeEntries('http://127.0.0.1:20000')].toSorted(),
  );

  expect(served.get('svc:raw')).toEqual([]);
});

test('no config, or output it cannot read, serves nothing', () => {
  expect(parseServedServices('').size).toBe(0);
  expect(parseServedServices('{}').size).toBe(0);
  expect(parseServedServices('No serve config').size).toBe(0);
});

test('it serves HTTP and HTTPS for a service, and drains before it clears', async () => {
  const commands: string[] = [];

  const serve = createServiceServe((argv) => {
    commands.push(argv.join(' '));

    return Promise.resolve('');
  });

  await serve.writeServe('svc:box', 'http://127.0.0.1:20000');
  await serve.drainServe('svc:box');
  await serve.clearServe('svc:box');

  expect(commands).toEqual([
    'tailscale serve --service=svc:box --http=80 http://127.0.0.1:20000',
    'tailscale serve --service=svc:box --https=443 http://127.0.0.1:20000',
    'tailscale serve drain svc:box',
    'tailscale serve clear svc:box',
  ]);
});
