import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubAcmeServer } from '../../test-utils/start-stub-acme-server';
import { createChalltestsrvProvider } from '../dns/challtestsrv-provider';
import { createAcmeIssuer } from './acme-issuer';
import { createCertStore } from './cert-store';

// impd's ACME issuer against a stub ACME server on loopback, for what Pebble
// never does; acme-issuer.pebble.ts runs it against Pebble.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-acme-issuer-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { stack, dir };
}

test('it rejects an order whose authorization offers no dns-01 challenge', async () => {
  const ctx = await setupTest();

  const server = startStubAcmeServer(ctx.stack, { challengeTypes: ['http-01', 'tls-alpn-01'] });

  const issue = createAcmeIssuer({
    directoryUrl: server.directoryUrl,
    email: null,
    caPem: null,
    store: createCertStore(ctx.dir),

    // never reached: the order fails before any TXT record goes up
    dns: createChalltestsrvProvider('http://127.0.0.1:9'),
    log: () => {},
  });

  const issued = issue('imp.test');

  expect(issued).rejects.toThrow(new Error('the CA offers no dns-01 challenge for imp.test'));
  expect(server.unexpected).toStrictEqual([]);
});
