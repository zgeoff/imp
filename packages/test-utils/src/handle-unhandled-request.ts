import { isLoopbackHost } from './is-loopback-host';

interface UnhandledRequestPrint {
  warning: () => void;
  error: () => void;
}

// A request to a loopback host goes through to the server a test started
// there; any other request no handler matches fails the test with its URL.
// oxlint-disable-next-line prefer-readonly-parameter-types -- MSW's own callback types
export function handleUnhandledRequest(request: Request, print: UnhandledRequestPrint): void {
  if (!isLoopbackHost(request.url)) {
    print.error();
  }
}
