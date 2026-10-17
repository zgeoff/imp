import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { waitOrAbort } from './wait-or-abort';

test('it leaves no abort listener on the signal once each wait has run out', async () => {
  const controller = new AbortController();

  await waitOrAbort(1, controller.signal);
  await waitOrAbort(1, controller.signal);
  await waitOrAbort(1, controller.signal);

  expect(getEventListeners(controller.signal, 'abort')).toBeEmpty();
});

test('it ends the wait at once when the signal aborts', async () => {
  const controller = new AbortController();

  // longer than the test's timeout, so only the abort can end it
  const waiting = waitOrAbort(60_000, controller.signal);

  controller.abort();

  await expect(waiting).toResolve();
});
