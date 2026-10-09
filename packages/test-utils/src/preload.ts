import { afterAll, afterEach, beforeAll } from 'bun:test';
import { server } from './mock-server';
import { registerRunHooks } from './register-run-hooks';
import { registerTracing } from './register-tracing';
import { buildRoutedFetch } from './route-fetch';

const nativeFetch = globalThis.fetch;

registerRunHooks();
registerTracing();

// MSW sees only remote fetches: loopback servers the suites start and unix
// sockets keep the native fetch (buildRoutedFetch)
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  globalThis.fetch = buildRoutedFetch(nativeFetch, globalThis.fetch);
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();

  globalThis.fetch = nativeFetch;
});
