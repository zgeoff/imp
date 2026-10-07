import { setupServer } from 'msw/node';

// The run's one MSW server. The preload starts it, resets its handlers after
// each test, and closes it at the end of the run; a test adds a handler of its
// own with `server.use(…)`.
export const server = setupServer();
