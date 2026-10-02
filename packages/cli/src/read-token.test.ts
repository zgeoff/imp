import { expect, test } from 'bun:test';
import { PromptCancelledError, readHiddenToken } from './read-token';
import type { TokenInput } from './read-token';

// a terminal that records raw mode and lets the test type
function setupTest() {
  const listeners = new Set<(chunk: Uint8Array | string) => void>();

  const modes: boolean[] = [];
  const written: string[] = [];

  const input: TokenInput = {
    isTTY: true,
    setRawMode: (raw) => modes.push(raw),
    on: (_, listener) => listeners.add(listener),
    off: (_, listener) => listeners.delete(listener),
    resume: () => null,
    pause: () => null,
  };

  return {
    input,
    modes,
    written,
    listeners,
    write: (text: string) => {
      written.push(text);
    },
    type: (text: string) => {
      for (const listener of listeners) {
        listener(text);
      }
    },
  };
}

test('it reads up to Enter with echo off, handles backspace, and restores the terminal', async () => {
  const ctx = setupTest();
  const token = readHiddenToken(ctx.input, ctx.write);

  ctx.type('secrx\u007Ft');
  ctx.type('\r');

  const value = await token;

  expect(value).toBe('secrt');
  expect(ctx.modes).toEqual([true, false]);
  expect(ctx.written).toEqual(['token: ', '\n']);
  expect(ctx.listeners.size).toBe(0);
});

test('arrow keys, Esc, Tab and bracketed-paste markers never enter the token', async () => {
  const ctx = setupTest();
  const token = readHiddenToken(ctx.input, ctx.write);

  ctx.type('\u001B[200~pas\u001B[Dte\u001B[201~');
  ctx.type('\u001BOA\t\u001B-x\u0001\r');

  const value = await token;

  expect(value).toBe('pastex');
});

test('Ctrl-C cancels and restores the terminal', async () => {
  const ctx = setupTest();
  const token = readHiddenToken(ctx.input, ctx.write);

  ctx.type('sec\u0003');

  const rejection = await token.catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(PromptCancelledError);
  expect(ctx.modes).toEqual([true, false]);
});

test('a SIGINT from elsewhere restores the terminal too', async () => {
  const ctx = setupTest();
  const token = readHiddenToken(ctx.input, ctx.write);

  process.emit('SIGINT');

  const rejection = await token.catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(PromptCancelledError);
  expect(ctx.modes).toEqual([true, false]);
  expect(process.listenerCount('SIGINT')).toBe(0);
});
