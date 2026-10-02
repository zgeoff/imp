import type { ReverseGuest } from '@zgeoff/imp-client';
import { UsageError } from './usage-error';

// The local side of a reverse forward: a unix socket or a port on this
// machine's 127.0.0.1.
export type ReverseLocal =
  | { readonly network: 'unix'; readonly path: string }
  | { readonly network: 'tcp'; readonly port: number };

// One `imp proxy --reverse` spec: GUEST:LOCAL. Each side is an absolute
// path or a port; a lone side is both. An empty GUEST is a socket the imp's
// agent makes, and a guest port 0 takes any free port.
export interface ReverseSpec {
  readonly guest: ReverseGuest;
  readonly local: ReverseLocal;
}

const MAX_PORT = 65_535;

const USAGE =
  'try GUEST:LOCAL, each an absolute path or a port: /tmp/app.sock:/run/app.sock, 9000:8080, or 9000';

function parsePort(text: string, min: number): number | null {
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;

  return port >= min && port <= MAX_PORT ? port : null;
}

function parseGuest(text: string): ReverseGuest | null {
  if (text === '') {
    return { network: 'unix', path: null };
  }

  if (text.startsWith('/')) {
    return { network: 'unix', path: text };
  }

  const port = parsePort(text, 0);

  return port === null ? null : { network: 'tcp', port };
}

function parseLocal(text: string): ReverseLocal | null {
  if (text.startsWith('/')) {
    return { network: 'unix', path: text };
  }

  const port = parsePort(text, 1);

  return port === null ? null : { network: 'tcp', port };
}

// A guest path holds no colon, so the first colon splits the sides.
export function parseReverse(spec: string): ReverseSpec {
  const colon = spec.indexOf(':');
  const guestText = colon === -1 ? spec : spec.slice(0, colon);
  const localText = colon === -1 ? spec : spec.slice(colon + 1);
  const guest = parseGuest(guestText);
  const local = parseLocal(localText);

  if (guest === null || local === null || (colon === -1 && spec === '')) {
    throw new UsageError(`not a reverse forward: ${spec} (${USAGE})`);
  }

  return { guest, local };
}

// every value of a repeated `--reverse`, which citty keeps only the last of
export function listReverseSpecs(rawArgs: readonly string[]): readonly string[] {
  const specs: string[] = [];

  for (const [index, arg] of rawArgs.entries()) {
    if (arg === '--reverse') {
      const value = rawArgs[index + 1];

      if (value !== undefined) {
        specs.push(value);
      }
    } else if (arg.startsWith('--reverse=')) {
      specs.push(arg.slice('--reverse='.length));
    }
  }

  return specs;
}
