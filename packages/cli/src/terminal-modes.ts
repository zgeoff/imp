// Modes a full-screen program sets on the terminal: once the session ends
// or detaches, nothing will set them back, so the CLI does.

const ESC = '\u001B';

// mouse reporting (X10, buttons, drags, motion, and the UTF-8, SGR, urxvt
// and pixel encodings), focus events, bracketed paste, application cursor
// keys: off; the cursor: shown; colors and styles: reset
const RESET_INPUT_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016, 1004, 2004, 1]
  .map((mode) => `${ESC}[?${String(mode)}l`)
  .join('');

const RESET_CURSOR_AND_STYLE = `${ESC}[?25h${ESC}[0m`;

// Leaving the alternate screen restores the saved cursor, which on a
// terminal that never entered it jumps the cursor home: only when it did.
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;

// kitty: a pop of more entries than the stack holds empties it
const POP_KITTY_KEYBOARD = `${ESC}[<99u`;
const ALT_SCREEN_MODES = ['1049', '1047', '47'];

// CSI > flags u pushes kitty keyboard flags
const KITTY_PUSH = /^\d*u/;

export interface ModeWatcher {
  readonly observe: (data: Uint8Array) => void;
  readonly buildReset: () => string;
}

// One sequence split across two chunks is missed, which only costs a reset
// that was not needed, or one that is not sent.
export function createModeWatcher(): ModeWatcher {
  const decoder = new TextDecoder('latin1');

  const seen = { altScreen: false, kitty: false };

  return {
    observe: (data) => {
      const text = decoder.decode(data);

      const entered = findLast(
        text,
        ALT_SCREEN_MODES.map((mode) => `${ESC}[?${mode}h`),
      );

      const left = findLast(
        text,
        ALT_SCREEN_MODES.map((mode) => `${ESC}[?${mode}l`),
      );

      if (entered !== left) {
        seen.altScreen = entered > left;
      }

      seen.kitty ||= hasKittyPush(text);
    },
    buildReset: () =>
      (seen.altScreen ? LEAVE_ALT_SCREEN : '') +
      RESET_INPUT_MODES +
      RESET_CURSOR_AND_STYLE +
      (seen.kitty ? POP_KITTY_KEYBOARD : ''),
  };
}

// the last index of any of `needles` in `text`, or -1
function findLast(text: string, needles: readonly string[]): number {
  return Math.max(...needles.map((needle) => text.lastIndexOf(needle)));
}

function hasKittyPush(text: string): boolean {
  const prefix = `${ESC}[>`;

  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    if (KITTY_PUSH.test(text.slice(at + prefix.length, at + prefix.length + 8))) {
      return true;
    }
  }

  return false;
}
