import { expect, test } from 'bun:test';
import { createSemaphore } from './semaphore';

test('it runs at most the limit of tasks at once', async () => {
  const semaphore = createSemaphore(2);
  const state = { active: 0, peak: 0 };

  const runTask = () =>
    semaphore.run(async () => {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);

      await Bun.sleep(5);

      state.active -= 1;
    });

  await Promise.all(Array.from({ length: 6 }, runTask));

  expect(state.peak).toBe(2);
  expect(state.active).toBe(0);
});
