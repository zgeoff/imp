import { instance } from './instance';

const DEFAULT_TIMEOUT_MS = 30_000;

// Requests go to localhost with the imp's Host header, so they do not depend
// on `*.localhost` resolving on this machine.
export function buildProxyHost(name: string): string {
  return `${name}.imp.localhost:${String(instance.proxyPort)}`;
}

export function sendProxyRequest(
  name: string,
  path = '/',
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(`http://localhost:${String(instance.proxyPort)}${path}`, {
    headers: { host: buildProxyHost(name) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// the imp's own published port, 20000 + slot
export function sendImpPortRequest(slot: number, path = '/'): Promise<Response> {
  return fetch(`http://localhost:${String(instance.impPortBase + slot)}${path}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}

// the trimmed body of a 2xx; throws on any other status
export async function readOkBody(pending: Promise<Response>): Promise<string> {
  const response = await pending;
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}: ${body.trim().slice(0, 200)}`);
  }

  return body.trim();
}

export function getThroughProxy(name: string, path = '/'): Promise<string> {
  return readOkBody(sendProxyRequest(name, path));
}
