import { afterAll, afterEach, beforeAll } from 'bun:test';
import { handleUnhandledRequest } from './handle-unhandled-request';
import { server } from './mock-server';
import { removeEnvOverrides } from './remove-env-overrides';
import { buildRoutedFetch } from './route-fetch';
import { setFakerSeed } from './set-faker-seed';

const nativeFetch = globalThis.fetch;
const NativeWebSocket = globalThis.WebSocket;

setFakerSeed();

// loopback servers the suites start, unix sockets and test CAs keep the native
// fetch (buildRoutedFetch); no suite mocks a WebSocket, so it stays native
beforeAll(() => {
  server.listen({ onUnhandledRequest: handleUnhandledRequest });

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
