import { UsageError } from './usage-error';

export const DEFAULT_DETACH_KEY = 'ctrl-]';

// the session `imp console` and `imp attach` use when none is named
export const DEFAULT_SESSION = 'main';

// ctrl-[ is Escape, and ctrl-h, ctrl-i, ctrl-j and ctrl-m are Backspace,
// Tab, Enter and Return: a program needs those
const RESERVED_KEYS = new Set(['[', 'h', 'i', 'j', 'm']);

// `ctrl-<key>` as the byte a terminal sends for it, or null for `none`.
// Ctrl clears the top three bits, so ctrl-] is 0x1d and ctrl-a is 0x01.
export function parseDetachKey(text: string): number | null {
  if (text === 'none') {
    return null;
  }

  const key = /^ctrl-(?<key>[a-z@[\\\]^_])$/i.exec(text)?.groups?.['key']?.toLowerCase();

  if (key === undefined || RESERVED_KEYS.has(key)) {
    throw new UsageError(
      `--detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \\, ], ^ or _) or none, got ${text}`,
    );
  }

  return (key.toUpperCase().codePointAt(0) ?? 0) & 0x1f;
}

export interface DetachKeyMatch {
  readonly at: number;
  readonly length: number;
}

// Finds the detach key in input: the plain byte, or the forms a terminal
// sends when a program turned on the kitty keyboard protocol (CSI cp;5u)
// or xterm's modifyOtherKeys (CSI 27;5;cp~). The earliest one wins.
export function findDetachKey(chunk: Uint8Array, key: number): DetachKeyMatch | null {
  const codepoint = String(readKeyCodepoint(key));

  const text = new TextDecoder('latin1').decode(chunk);

  const matches = [
    { at: chunk.indexOf(key), length: 1 },
    ...[`\u001B[${codepoint};5u`, `\u001B[27;5;${codepoint}~`].map((form) => ({
      at: text.indexOf(form),
      length: form.length,
    })),
  ].filter((match) => match.at !== -1);

  if (matches.length === 0) {
    return null;
  }

  return matches.reduce((first, match) => (match.at < first.at ? match : first));
}

// the key ctrl was held with: a letter in lower case, as kitty reports it,
// else the symbol
function readKeyCodepoint(key: number): number {
  return key >= 0x01 && key <= 0x1a ? 0x60 + key : 0x40 + key;
}
