import { DEFAULT_DETACH_KEY, parseDetachKey } from '../detach-key';
import { printError } from '../run-action';

export const nameArg = { type: 'positional', description: 'imp name', required: true } as const;
export const jsonArg = { type: 'boolean', description: 'print JSON' } as const;

export const detachKeyArg = {
  type: 'string',
  description: 'key that detaches from the session: ctrl-<key>, or none',
  default: DEFAULT_DETACH_KEY,
} as const;

// the --detach-key byte, or undefined once a bad key is reported
export function readDetachKey(text: string): number | null | undefined {
  try {
    return parseDetachKey(text);
  } catch (error) {
    printError(error);

    return undefined;
  }
}
