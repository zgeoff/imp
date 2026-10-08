import { expect, onTestFinished, test } from 'bun:test';
import { startWarmMoveHosts } from './start-warm-move-hosts';

test('it serves two hosts that report the same warm facts', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await startWarmMoveHosts(stack);
  const sourceFacts = await hosts.from.moves.facts();
  const targetFacts = await hosts.to.moves.facts();

  expect(sourceFacts).toStrictEqual(targetFacts);
});

test('it gives each host the ubuntu image', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await startWarmMoveHosts(stack);
  const sourceImages = await hosts.from.images.list();
  const targetImages = await hosts.to.images.list();

  expect(sourceImages.map((image) => image.name)).toStrictEqual(['ubuntu']);
  expect(targetImages.map((image) => image.name)).toStrictEqual(['ubuntu']);
});

test('it stops listening once the stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await startWarmMoveHosts(stack);

  await stack.disposeAsync();

  expect(hosts.from.system.info()).rejects.toThrow();
});
