import { expect, mock, test } from 'bun:test';
import { buildStubGuestListener } from '../test-utils/build-stub-guest-listener';
import { runGuestListener } from './run-guest-listener';

test('it delivers clients until the forward is full and refuses the rest', async () => {
  const guest = buildStubGuestListener('ab', { network: 'tcp', port: 9000 });
  const delivered: number[] = [];
  const refused: number[] = [];

  guest.connect(1);
  guest.connect(2);
  guest.connect(3);
  guest.connect(4);
  guest.end();

  await runGuestListener(guest.listener, {
    // each relay stays open
    deliver: (id) => {
      delivered.push(id);

      return new Promise(() => {});
    },
    refuse: (id) => {
      refused.push(id);

      return Promise.resolve();
    },
    isFull: () => delivered.length >= 2,
  });

  expect(delivered).toStrictEqual([1, 2]);
  expect(refused).toStrictEqual([3, 4]);
});

test('it settles once the guest listener ends, with no client handed on', async () => {
  const guest = buildStubGuestListener('ab', { network: 'tcp', port: 9000 });
  const deliver = mock(() => Promise.resolve());
  const refuse = mock(() => Promise.resolve());

  guest.end();

  await runGuestListener(guest.listener, { deliver, refuse, isFull: () => false });

  expect(deliver).not.toHaveBeenCalled();
  expect(refuse).not.toHaveBeenCalled();
});
