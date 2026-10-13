import { expect, onTestFinished, test } from 'bun:test';
import { createEventBus } from '../events/event-bus';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createImage } from './images';
import type { ImpWrite } from './imp-write-feed';
import { createImp } from './imps';
import { openDatabase } from './open-database';

test('it publishes each imp write on the feed it was given', async () => {
  const writes = createEventBus<ImpWrite>();
  const seen: ImpWrite[] = [];

  writes.subscribe((write) => {
    seen.push(write);
  });

  const db = await openDatabase(':memory:', { writes });

  onTestFinished(() => db.destroy());

  const image = await createImage(db, buildMockNewImage());
  const imp = await createImp(db, buildMockNewImp({ imageId: image.id }));

  expect(seen).toStrictEqual([{ kind: 'added', imp }]);
});

test('it gives each database a feed of its own when none is given', async () => {
  const first = await openDatabase(':memory:');

  onTestFinished(() => first.destroy());

  const second = await openDatabase(':memory:');

  onTestFinished(() => second.destroy());

  const seen: ImpWrite[] = [];

  second.writes.subscribe((write) => {
    seen.push(write);
  });

  const image = await createImage(first, buildMockNewImage());

  await createImp(first, buildMockNewImp({ imageId: image.id }));

  expect(seen).toStrictEqual([]);
});
