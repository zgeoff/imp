import { DEFAULT_DETACH_KEY } from '../detach-key';
import { UsageError } from '../usage-error';

export const nameArg = { type: 'positional', description: 'imp name', required: true } as const;
export const jsonArg = { type: 'boolean', description: 'print JSON' } as const;

export const detachKeyArg = {
  type: 'string',
  description: 'key that detaches from the session: ctrl-<key>, or none',
  default: DEFAULT_DETACH_KEY,
} as const;

// the session name; impd checks the rest of its form
export function requireSessionName(session: string): string {
  if (session === '') {
    throw new UsageError('a session needs a name');
  }

  return session;
}
