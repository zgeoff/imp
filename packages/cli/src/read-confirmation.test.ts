import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { readConfirmation } from './read-confirmation';

async function readAnswer(typed: string) {
  const input = new PassThrough();
  const output = new PassThrough();

  const asked = readConfirmation('Approve? [y/N] ', { input, output });

  input.end(typed);

  const answer = await asked;

  const shown = String(output.read() ?? '');

  return { answer, shown };
}

test('only y or yes approves', async () => {
  for (const typed of ['y\n', 'YES\n', ' yes \n']) {
    const result = await readAnswer(typed);

    expect(result.answer).toBeTrue();
  }

  for (const typed of ['\n', 'n\n', 'yep\n', '']) {
    const result = await readAnswer(typed);

    expect(result.answer).toBeFalse();
  }
});

test('it asks on the output it is given', async () => {
  const result = await readAnswer('n\n');

  expect(result.shown).toBe('Approve? [y/N] ');
});
