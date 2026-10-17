import { expect, mock, test } from 'bun:test';
import { dispatchVerb } from './dispatch-verb';

test('#dispatchVerb runs the verb the first word names, with the words after it', async () => {
  const rm = mock<(operands: readonly string[]) => Promise<void>>(() => Promise.resolve());
  const runOwnForm = mock(() => Promise.resolve());

  await dispatchVerb(['rm', 'box', 'cp1'], { rm }, runOwnForm);

  expect(rm).toHaveBeenCalledExactlyOnceWith(['box', 'cp1']);
  expect(runOwnForm).not.toHaveBeenCalled();
});

test('#dispatchVerb runs the command’s own form for a first word that names no verb', async () => {
  const rm = mock<(operands: readonly string[]) => Promise<void>>(() => Promise.resolve());
  const runOwnForm = mock(() => Promise.resolve());

  await dispatchVerb(['box', 'before-upgrade'], { rm }, runOwnForm);

  expect(runOwnForm).toHaveBeenCalledTimes(1);
  expect(rm).not.toHaveBeenCalled();
});

test('#dispatchVerb takes no verb from the prototype of its table', async () => {
  const runOwnForm = mock(() => Promise.resolve());

  await dispatchVerb(['toString'], {}, runOwnForm);

  expect(runOwnForm).toHaveBeenCalledTimes(1);
});
