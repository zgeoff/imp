import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { readConfirmation } from './read-confirmation';

test.each(['y\n', 'YES\n', ' yes \n'])('it approves the answer %p', (typed) => {
  const input = new PassThrough();

  const asked = readConfirmation('Approve? [y/N] ', { input, output: new PassThrough() });

  input.end(typed);

  expect(asked).resolves.toBeTrue();
});

test.each(['\n', 'n\n', 'yep\n', ''])('it refuses the answer %p', (typed) => {
  const input = new PassThrough();

  const asked = readConfirmation('Approve? [y/N] ', { input, output: new PassThrough() });

  input.end(typed);

  expect(asked).resolves.toBeFalse();
});

test('it asks the question on the output it is given', async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const asked = readConfirmation('Approve? [y/N] ', { input, output });

  input.end('n\n');

  await asked;

  expect(String(output.read())).toBe('Approve? [y/N] ');
});
