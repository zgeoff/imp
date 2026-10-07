import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { SetupServerApi } from 'msw/node';

// The run's one MSW server. It intercepts fetch only: node:http clients such as
// acme-client talk to loopback servers the suites start, and no suite mocks one.
// oxlint-disable-next-line no-deprecated -- setupServer takes no interceptor list; its successor is experimental
export const server = new SetupServerApi([], [new FetchInterceptor()]);
