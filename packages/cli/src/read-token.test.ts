import { expect, test } from 'bun:test';
import { PromptCancelledError, readToken } from './read-token';
import { buildStubSignals } from './test-utils/build-stub-signals';
import { buildStubTerminal } from './test-utils/build-stub-terminal';

test('it reads a typed token up to Enter with echo off, then puts the terminal back', async () => {
  const terminal = buildStubTerminal();
  const written: string[] = [];

  const reading = readToken('token: ', {
    input: terminal.stdin,
    write: (text) => {
      written.push(text);
    },
    readPiped: () => Promise.resolve(''),
    signals: buildStubSignals().signals,
  });

  terminal.stdin.write('secrx\u007Ft\r');

  const token = await reading;

  expect(token).toBe('secrt');
  expect(terminal.modes).toStrictEqual([true, false]);
  expect(written).toStrictEqual(['token: ', '\n']);
  expect(terminal.stdin.listenerCount('data')).toBe(0);
});

test('it keeps arrow keys, Esc, Tab and bracketed-paste markers out of the token', async () => {
  const terminal = buildStubTerminal();

  const reading = readToken('token: ', {
    input: terminal.stdin,
    write: () => {},
    readPiped: () => Promise.resolve(''),
    signals: buildStubSignals().signals,
  });

  terminal.stdin.write('\u001B[200~pas\u001B[Dte\u001B[201~\u001BOA\t\u001B-x\u0001\r');

  const token = await reading;

  expect(token).toBe('pastex');
});

test('it cancels on Ctrl-C and puts the terminal back', () => {
  const terminal = buildStubTerminal();

  const reading = readToken('token: ', {
    input: terminal.stdin,
    write: () => {},
    readPiped: () => Promise.resolve(''),
    signals: buildStubSignals().signals,
  });

  terminal.stdin.write('sec\u0003');

  expect(reading).rejects.toThrow(PromptCancelledError);
  expect(terminal.modes).toStrictEqual([true, false]);
});

test('it cancels on a signal from elsewhere and stops listening for signals', () => {
  const terminal = buildStubTerminal();
  const signals = buildStubSignals();

  const reading = readToken('token: ', {
    input: terminal.stdin,
    write: () => {},
    readPiped: () => Promise.resolve(''),
    signals: signals.signals,
  });

  signals.send('SIGHUP');

  expect(reading).rejects.toThrow(PromptCancelledError);
  expect(terminal.modes).toStrictEqual([true, false]);
  expect(signals.listening()).toBeEmpty();
});

test('it writes the prompt it is given', async () => {
  const terminal = buildStubTerminal();
  const written: string[] = [];

  const reading = readToken('value for gh: ', {
    input: terminal.stdin,
    write: (text) => {
      written.push(text);
    },
    readPiped: () => Promise.resolve(''),
    signals: buildStubSignals().signals,
  });

  terminal.stdin.write('\r');

  await reading;

  expect(written).toStrictEqual(['value for gh: ', '\n']);
});

test('it reads the first line of piped stdin, trimmed, when stdin is no terminal', async () => {
  const terminal = buildStubTerminal();

  terminal.stdin.isTTY = false;

  const token = await readToken('token: ', {
    input: terminal.stdin,
    write: () => {},
    readPiped: () => Promise.resolve('  ghp_token \nsecond line\n'),
    signals: buildStubSignals().signals,
  });

  expect(token).toBe('ghp_token');
  expect(terminal.modes).toBeEmpty();
});

test('it reads an empty token from empty piped stdin', async () => {
  const terminal = buildStubTerminal();

  terminal.stdin.isTTY = false;

  const token = await readToken('token: ', {
    input: terminal.stdin,
    write: () => {},
    readPiped: () => Promise.resolve(''),
    signals: buildStubSignals().signals,
  });

  expect(token).toBe('');
});
