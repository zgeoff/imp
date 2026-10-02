import { expect, test } from 'bun:test';
import type { GuestListener } from '../agent-client/listener-stream';
import { runGuestListener } from './run-guest-listener';

function buildListener(ids: readonly number[]): GuestListener {
  return {
    path: null,
    port: 9000,
    id: 'ab',
    async *connections() {
      for (const id of ids) {
        await Bun.sleep(1);

        yield id;
      }
    },
    close: () => {},
  };
}

test('clients past the cap are refused, and the rest delivered', async () => {
  const delivered: number[] = [];
  const refused: number[] = [];
  const state = { open: 0 };

  await runGuestListener(buildListener([1, 2, 3, 4]), {
    // each relay stays open
    deliver: (id) => {
      delivered.push(id);

      state.open += 1;

      return new Promise(() => {});
    },
    refuse: (id) => {
      refused.push(id);

      return Promise.resolve();
    },
    isFull: () => state.open >= 2,
  });

  expect(delivered).toEqual([1, 2]);
  expect(refused).toEqual([3, 4]);
});
