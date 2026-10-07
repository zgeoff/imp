import { expect, test } from 'bun:test';
import { findDetachKey, parseDetachKey } from './detach-key';
import { UsageError } from './usage-error';

test.each([
  ['ctrl-]', 0x1d],
  ['ctrl-a', 0x01],
  ['ctrl-Q', 0x11],
  ['ctrl-\\', 0x1c],
])('#parseDetachKey reads %p as the byte %p the terminal sends', (text, byte) => {
  expect(parseDetachKey(text)).toBe(byte);
});

test('#parseDetachKey reads none as no detach key', () => {
  expect(parseDetachKey('none')).toBeNull();
});

// the last five are the keys a program needs: Escape, Backspace, Tab, Enter
// and Return
test.each([
  'ctrl-1',
  'ctrl-',
  'ctrl-ab',
  'esc',
  '',
  'ctrl-[',
  'ctrl-h',
  'ctrl-I',
  'ctrl-j',
  'ctrl-m',
])('#parseDetachKey rejects %p as a usage error', (text) => {
  expect(() => parseDetachKey(text)).toThrowWithMessage(
    UsageError,
    String.raw`--detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \, ], ^ or _) or none, got ` +
      text,
  );
});

test.each([
  ['the plain byte', 'ls\u001D', 0x1d, { at: 2, length: 1 }],
  ['the kitty form', 'ls\u001B[93;5u', 0x1d, { at: 2, length: 7 }],
  ['the modifyOtherKeys form', '\u001B[27;5;93~x', 0x1d, { at: 0, length: 10 }],
  ['the kitty form of a letter', 'a\u001B[97;5u', 0x01, { at: 1, length: 7 }],
  ['the earliest of two forms', '\u001B[93;5u then \u001D', 0x1d, { at: 0, length: 7 }],
])('#findDetachKey finds the key as %s', (_form, text, key, match) => {
  expect(findDetachKey(new TextEncoder().encode(text), key)).toStrictEqual(match);
});

test('#findDetachKey finds nothing when the key is held with another modifier', () => {
  expect(findDetachKey(new TextEncoder().encode('\u001B[93;3u'), 0x1d)).toBeNull();
});
