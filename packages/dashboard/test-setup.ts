import { afterAll, afterEach, beforeAll, mock } from 'bun:test';
import { registerRunHooks } from '@imp/test-utils/register-run-hooks';
import { IMPD_ORIGIN, knownTokens } from './src/mocks/handlers';
import { server } from './src/mocks/node';

declare global {
  // happy-dom's own API on the window that @zgeoff/bun-test-react registers
  var happyDOM: { readonly setURL: (url: string) => void };
}

// a seeded faker, and every env override put back after each test
registerRunHooks();

// the page's own origin, as impd serves the dashboard: the session routes
// (src/lib/session.ts) fetch relative URLs
globalThis.happyDOM.setURL(`${IMPD_ORIGIN}/ui/`);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  knownTokens.clear();
  mock.restore();
});

afterAll(() => {
  server.close();
});
