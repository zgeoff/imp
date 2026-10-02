import { expect, test } from 'bun:test';
import { findDetachKey, parseDetachKey } from './detach-key';

test('it reads ctrl-<key> as the byte the terminal sends', () => {
  expect(parseDetachKey('ctrl-]')).toBe(0x1d);
  expect(parseDetachKey('ctrl-a')).toBe(0x01);
  expect(parseDetachKey('ctrl-Q')).toBe(0x11);
  expect(parseDetachKey('ctrl-\\')).toBe(0x1c);
  expect(parseDetachKey('none')).toBeNull();
});

test('it refuses anything else as a usage error', () => {
  for (const key of ['ctrl-1', 'ctrl-', 'ctrl-ab', 'esc', '']) {
    expect(() => parseDetachKey(key)).toThrow('--detach-key takes ctrl-<key>');
  }
});

test('it refuses the keys a program needs: Escape, Backspace, Tab, Enter and Return', () => {
  for (const key of ['ctrl-[', 'ctrl-h', 'ctrl-I', 'ctrl-j', 'ctrl-m']) {
    expect(() => parseDetachKey(key)).toThrow('--detach-key takes ctrl-<key>');
  }
});

test('it finds the key as a byte, in the kitty form and in the modifyOtherKeys form', () => {
  const encoder = new TextEncoder();

  const find = (text: string, key: number) => findDetachKey(encoder.encode(text), key);

  expect(find('ls\u001D', 0x1d)).toEqual({ at: 2, length: 1 });
  expect(find('ls\u001B[93;5u', 0x1d)).toEqual({ at: 2, length: 7 });
  expect(find('\u001B[27;5;93~x', 0x1d)).toEqual({ at: 0, length: 10 });
  expect(find('a\u001B[97;5u', 0x01)).toEqual({ at: 1, length: 7 });
  expect(find('\u001B[93;5u then \u001D', 0x1d)).toEqual({ at: 0, length: 7 });
  expect(find('\u001B[93;3u', 0x1d)).toBeNull();
});
