// How imp-docker-proxy words a refusal, and how impd finds one again in
// what reaches it: a 403 body from the proxy, or the docker CLI's stderr.

import { z } from 'zod';

// the start of every message the proxy writes itself
const PROXY_PREFIX = 'imp-docker-proxy: ';

// the one such message that is no refusal: the engine call failed, a 502
const ENGINE_FAILURE_PREFIX = `${PROXY_PREFIX}the engine call failed: `;

// a refusal names one ref or path at most; this bounds what a client gets
const REFUSAL_MAX_CHARS = 1000;

// how the docker CLI prints an error answer from the engine
const DAEMON_ERROR_PREFIX = 'Error response from daemon: ';
const RefusalBodySchema = z.object({ message: z.string() });

export function formatRefusal(reason: string): string {
  return `${PROXY_PREFIX}${reason}`;
}

export function formatEngineFailure(message: string): string {
  return `${ENGINE_FAILURE_PREFIX}${message}`;
}

// The proxy's refusal in its 403 body or as the engine error the CLI
// prints, alone on one line; a refusal inside another error, which a
// registry may have written, is none. Null when the text holds none.
export function readProxyRefusal(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const answer = line.startsWith(DAEMON_ERROR_PREFIX)
      ? line.slice(DAEMON_ERROR_PREFIX.length)
      : null;

    const message = readJsonMessage(answer ?? line) ?? answer;

    if (message?.startsWith(PROXY_PREFIX) === true && !message.startsWith(ENGINE_FAILURE_PREFIX)) {
      const firstLine = message.split('\n', 1)[0] ?? '';

      return firstLine.trim().slice(0, REFUSAL_MAX_CHARS);
    }
  }

  return null;
}

// the message of the proxy's JSON body, { "message": "…" }; null otherwise
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
