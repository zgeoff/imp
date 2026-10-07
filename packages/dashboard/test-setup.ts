import { afterAll, afterEach, beforeAll, mock } from 'bun:test';
import { registerRunHooks } from '@imp/test-utils/register-run-hooks';
import { IMPD_ORIGIN, knownTokens } from './src/mocks/handlers';
import { server } from './src/mocks/node';
import { buildStubBrowserFetch } from './src/test-utils/build-stub-browser-fetch';

const bunFetch = globalThis.fetch;

declare global {
  // happy-dom's own API on the window that @zgeoff/bun-test-react registers
  var happyDOM: { readonly setURL: (url: string) => void };
}

// a seeded faker, and every env override put back after each test
registerRunHooks();

// the page's own origin, as impd serves the dashboard
globalThis.happyDOM.setURL(`${IMPD_ORIGIN}/ui/`);

// a browser marks the page's own requests with Sec-Fetch-Site, which impd's
// session routes need; wrapped around MSW's fetch, so MSW sees the header
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  globalThis.fetch = buildStubBrowserFetch(globalThis.fetch, `${IMPD_ORIGIN}/ui/`);
});

afterEach(() => {
  server.resetHandlers();
  knownTokens.clear();
  mock.restore();
});

afterAll(() => {
  server.close();

  globalThis.fetch = bunFetch;
});
