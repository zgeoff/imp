import { expect, test } from 'bun:test';
import { buildStubRoomCheck } from './build-stub-room-check';

test('it finds room for the first checks it passes', async () => {
  const room = buildStubRoomCheck({ passes: 2, error: new Error('full') });

  await room.requireRoom(10);

  expect(room.requireRoom(10)).resolves.toBeUndefined();
});

test('it rejects every check past the ones it passes with the given error', async () => {
  const full = new Error('full');

  const room = buildStubRoomCheck({ passes: 1, error: full });

  await room.requireRoom(10);

  const second = await room.requireRoom(10).then(
    () => null,
    (error: unknown) => error,
  );

  const third = await room.requireRoom(4).then(
    () => null,
    (error: unknown) => error,
  );

  expect(second).toBe(full);
  expect(third).toBe(full);
});

test('it records the bytes of each check in order', async () => {
  const room = buildStubRoomCheck({ passes: 1, error: new Error('full') });

  await room.requireRoom(10);
  await room.requireRoom(4).catch(() => {});

  expect(room.asked).toStrictEqual([10, 4]);
});
