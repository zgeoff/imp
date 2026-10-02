import { expect, test } from 'bun:test';
import { parseDetachKey } from './detach-key';

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
