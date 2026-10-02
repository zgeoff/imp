// Modes a full-screen program sets on the terminal: once the session ends
// or detaches, nothing will set them back, so the CLI does.

const ESC = '\u001B';

// mouse reporting (X10, buttons, drags, motion, and the UTF-8, SGR, urxvt
// and pixel encodings) and focus events: always off, no shell wants them
const RESET_MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016, 1004]
  .map((mode) => `${ESC}[?${String(mode)}l`)
  .join('');

// the cursor shown, colors and styles reset, xterm's modifyOtherKeys off
const RESET_CURSOR_AND_KEYS = `${ESC}[?25h${ESC}[0m${ESC}[>4;0m`;

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

const BRACKETED_PASTE = 2004;
const CURSOR_KEYS = 1;

// a CSI sequence (prefix, parameters, final byte), or RIS, a full reset
// oxlint-disable-next-line no-control-regex -- terminal sequences start with ESC
const SEQUENCE = /\u001B\[(?<prefix>[<=>?]?)(?<params>[\d:;]*)(?<final>[@-~])|\u001Bc/g;

// a sequence cut off at the end of a chunk is kept for the next one
const MAX_CARRY = 32;

export interface ModeWatcher {
  readonly observe: (data: Uint8Array) => void;
  readonly buildReset: () => string;
}

interface Seen {
  altScreen: boolean;
  paste: boolean;
  cursorKeys: boolean;

  // kitty keyboard pushes less pops, per screen as kitty keeps them
  kitty: { main: number; alt: number };
}

function createSeen(): Seen {
  return { altScreen: false, paste: false, cursorKeys: false, kitty: { main: 0, alt: 0 } };
}

// Turns off what the session turned on, and leaves alone what it did not:
// the local shell may use bracketed paste or cursor keys itself.
export function createModeWatcher(): ModeWatcher {
  const decoder = new TextDecoder('latin1');

  const watch = { seen: createSeen(), carry: '' };

  const apply = (prefix: string, params: string, final: string): void => {
    const seen = watch.seen;
    const numbers = params.split(';').map(Number);
    const screen = seen.altScreen ? 'alt' : 'main';

    if (prefix === '?' && (final === 'h' || final === 'l')) {
      for (const mode of numbers) {
        if (ALT_SCREEN_MODES.has(mode)) {
          seen.altScreen = final === 'h';
        } else if (mode === BRACKETED_PASTE) {
          seen.paste = final === 'h';
        } else if (mode === CURSOR_KEYS) {
          seen.cursorKeys = final === 'h';
        }
      }
    } else if (prefix === '>' && final === 'u') {
      seen.kitty[screen] += 1;
    } else if (prefix === '<' && final === 'u') {
      seen.kitty[screen] = Math.max(0, seen.kitty[screen] - Math.max(1, numbers[0] ?? 1));
    }
  };

  return {
    observe: (data) => {
      const text = watch.carry + decoder.decode(data);
      let end = 0;

      for (const match of text.matchAll(SEQUENCE)) {
        end = match.index + match[0].length;

        const groups = match.groups;

        if (groups?.['final'] === undefined) {
          watch.seen = createSeen();
        } else {
          apply(groups['prefix'] ?? '', groups['params'] ?? '', groups['final']);
        }
      }

      const open = text.lastIndexOf(ESC);

      watch.carry = open >= end && text.length - open < MAX_CARRY ? text.slice(open) : '';
    },
    buildReset: () => {
      const seen = watch.seen;

      return [
        buildKittyPop(seen.kitty.alt),
        seen.altScreen ? `${ESC}[?1049l` : '',
        buildKittyPop(seen.kitty.main),
        RESET_MOUSE_MODES,
        seen.paste ? `${ESC}[?${String(BRACKETED_PASTE)}l` : '',
        seen.cursorKeys ? `${ESC}[?${String(CURSOR_KEYS)}l` : '',
        RESET_CURSOR_AND_KEYS,
      ].join('');
    },
  };
}

function buildKittyPop(count: number): string {
  return count > 0 ? `${ESC}[<${String(count)}u` : '';
}
