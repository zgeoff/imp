import { expect, mock, test } from 'bun:test';
import { registerRemoval } from './register-removal';

test('it removes when the stack is disposed', async () => {
  const stack = new AsyncDisposableStack();

  const remove = mock(() => Promise.resolve());

  registerRemoval(stack, false, remove);

  await stack.disposeAsync();

  expect(remove).toHaveBeenCalledOnce();
});

test('it skips the removal with --keep', async () => {
  const stack = new AsyncDisposableStack();

  const remove = mock(() => Promise.resolve());

  registerRemoval(stack, true, remove);

  await stack.disposeAsync();

  expect(remove).not.toHaveBeenCalled();
});
