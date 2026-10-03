// How imp-docker-proxy words a refusal, and how impd finds one again in
// what reaches it: a 403 body from the proxy, or the docker CLI's stderr.

import { z } from 'zod';

// the start of every message the proxy writes itself
const PROXY_PREFIX = 'imp-docker-proxy: ';

// the one such message that is no refusal: the engine call failed, a 502
const ENGINE_FAILURE_PREFIX = `${PROXY_PREFIX}the engine call failed: `;

// a refusal names one ref or path at most; this bounds what a client gets
const REFUSAL_MAX_CHARS = 1000;

// how the docker CLI prints an error answer from the engine, and the one
// line it may print before it: a create of an image the engine lacks
const DAEMON_ERROR_PREFIX = 'Error response from daemon: ';
const UNABLE_TO_FIND_LINE = /^Unable to find image '[^'\n]+' locally$/;

// the proxy's body exactly: { "message": "…" } and nothing else
const RefusalBodySchema = z.strictObject({ message: z.string() });

export function formatRefusal(reason: string): string {
  return `${PROXY_PREFIX}${reason}`;
}

export function formatEngineFailure(message: string): string {
  return `${ENGINE_FAILURE_PREFIX}${message}`;
}

// The proxy's refusal when it is the whole text: its 403 body, or stderr of
// the engine error alone (docs/architecture/host-contract.md#the-docker-socket).
// A registry's text can add lines, so a refusal among others is none.
export function readProxyRefusal(text: string): string | null {
  const body = readJsonMessage(text.trim());

  if (body !== null) {
    return toRefusal(body);
  }

  const errorLine = readErrorLine(text.trimEnd().split('\n'));

  if (!errorLine.startsWith(DAEMON_ERROR_PREFIX)) {
    return null;
  }

  const answer = errorLine.slice(DAEMON_ERROR_PREFIX.length);

  return toRefusal(readJsonMessage(answer) ?? answer);
}

// the one line of stderr, or the line after the CLI's own for a create;
// empty for any other stderr
function readErrorLine(lines: readonly string[]): string {
  const [first = '', second = ''] = lines;

  if (lines.length === 1) {
    return first;
  }

  return lines.length === 2 && UNABLE_TO_FIND_LINE.test(first) ? second : '';
}

// the proxy's own message, one line, capped; null for any other message,
// and for its engine failure
function toRefusal(message: string): string | null {
  if (!message.startsWith(PROXY_PREFIX) || message.startsWith(ENGINE_FAILURE_PREFIX)) {
    return null;
  }

  const firstLine = message.split('\n', 1)[0] ?? '';

  return firstLine.trim().slice(0, REFUSAL_MAX_CHARS);
}

// the message of the proxy's JSON body, when the text is that body alone;
// null otherwise
function readJsonMessage(text: string): string | null {
  if (!text.startsWith('{')) {
    return null;
  }

  try {
    const body = RefusalBodySchema.safeParse(JSON.parse(text));

    return body.success ? body.data.message : null;
  } catch {
    // not JSON: not the proxy's body
    return null;
  }
}
