import { afterAll, afterEach, beforeAll } from 'bun:test';
import { server } from './mock-server';
import { removeEnvOverrides } from './remove-env-overrides';
import { buildRoutedFetch } from './route-fetch';
import { setFakerSeed } from './set-faker-seed';

const nativeFetch = globalThis.fetch;
const NativeWebSocket = globalThis.WebSocket;

setFakerSeed();

// MSW sees only remote requests: loopback servers the suites start and unix
// sockets keep the native fetch (buildRoutedFetch), and no suite mocks a WebSocket
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  globalThis.fetch = buildRoutedFetch(nativeFetch, globalThis.fetch);
  globalThis.WebSocket = NativeWebSocket;
});

afterEach(() => {
  server.resetHandlers();

  removeEnvOverrides();
});

afterAll(() => {
  server.close();

  globalThis.fetch = nativeFetch;
});
