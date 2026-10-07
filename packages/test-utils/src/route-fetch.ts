import { isLoopbackHost } from './is-loopback-host';

type Fetch = typeof fetch;

// oxlint-disable-next-line prefer-readonly-parameter-types -- fetch's own parameter types
type SendRequest = (input: Parameters<Fetch>[0], init?: BunFetchRequestInit) => Promise<Response>;

// A request over a unix socket, or to a loopback host, goes to the native
// fetch: MSW rebuilds a request it lets through and drops Bun's own options
// (`unix`, `tls`). Every other request goes to MSW's fetch.
// oxlint-disable-next-line prefer-readonly-parameter-types -- fetch functions carry mutable statics
export function buildRoutedFetch(nativeFetch: Fetch, mockedFetch: Fetch): Fetch {
  const sendRequest: SendRequest = (input, init) => {
    const href = input instanceof Request ? input.url : input.toString();
    const isLocal = init?.unix !== undefined || (URL.canParse(href) && isLoopbackHost(href));

    if (isLocal) {
      return nativeFetch(input, init);
    }

    return mockedFetch(input, init);
  };

  return Object.assign(sendRequest, { preconnect: nativeFetch.preconnect });
}
