import { expect, test } from 'bun:test';
import { createNftWriter } from './egress-firewall';

test('scripts that wait while one runs go together, in order', async () => {
  const runs: string[] = [];
  const gate = Promise.withResolvers<void>();

  const write = createNftWriter(async (script) => {
    runs.push(script);

    if (runs.length === 1) {
      await gate.promise;
    }
  });

  const first = write('a\n');
  const second = write('b\n');
  const third = write('c\n');

  gate.resolve();

  await Promise.all([first, second, third]);

  expect(runs).toEqual(['a\n', 'b\nc\n']);
});

test('a failed batch runs again one script at a time, and fails only the bad one', async () => {
  const runs: string[] = [];
  const gate = Promise.withResolvers<void>();

  const write = createNftWriter(async (script) => {
    runs.push(script);

    if (runs.length === 1) {
      await gate.promise;
    }

    if (script.includes('bad')) {
      throw new Error('nft exited 1: syntax error');
    }
  });

  const first = write('a\n');
  const good = write('b\n');
  const bad = write('bad\n');

  gate.resolve();

  await first;
  await good;

  const error = await bad.catch(String);

  expect(error).toContain('syntax error');
  expect(runs).toEqual(['a\n', 'b\nbad\n', 'b\n', 'bad\n']);
});
