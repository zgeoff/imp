import { UsageError } from './usage-error';

export const DEFAULT_DETACH_KEY = 'ctrl-]';

// the session `imp console` and `imp attach` use when none is named
export const DEFAULT_SESSION = 'main';

// `ctrl-<key>` as the byte a terminal sends for it, or null for `none`.
// Ctrl clears the top three bits, so ctrl-] is 0x1d and ctrl-a is 0x01.
export function parseDetachKey(text: string): number | null {
  if (text === 'none') {
    return null;
  }

  const key = /^ctrl-(?<key>[a-z@[\\\]^_])$/i.exec(text)?.groups?.['key'];

  if (key === undefined) {
    throw new UsageError(
      `--detach-key takes ctrl-<key> (a-z, @, [, \\, ], ^ or _) or none, got ${text}`,
    );
  }

  return (key.toUpperCase().codePointAt(0) ?? 0) & 0x1f;
}
