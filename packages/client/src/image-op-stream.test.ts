import { expect, test } from 'bun:test';
import type { ImageBuildPhase } from '@imp/api';
import { createImage } from '@imp/daemon/src/db/images';
import { TEST_TOKEN, setupImpTest } from '@imp/daemon/src/imps/test-imps';
import { createImpClient } from './create-imp-client';
import { createIdleFetch, startSlowImpd } from './test-slow-impd';
import type { SlowImpdHarness } from './test-slow-impd';

// impd whose add and on-host build each take `workMs`; `onWork` hears each
// one, which goes on after its client gave up, so the test can wait for it
// before the database closes
function startSlowOps(
  harness: SlowImpdHarness,
  workMs: number,
  keepaliveMs: number,
  onWork: (made: Promise<unknown>) => void,
) {
  const makeImage = (name: string) => {
    const made = (async () => {
      await Bun.sleep(workMs);

      return createImage(harness.db, {
        name,
        ref: `imp/${name}:latest`,
        digest: 'sha256:x',
        sizeBytes: 1,
      });
    })();

    onWork(made);

    return made;
  };

  return startSlowImpd(
    harness,
    {
      addImage: (_, name) => makeImage(name ?? 'added'),
      buildImage: (_, name) => makeImage(name),
    },
    keepaliveMs,
  );
}

test('an add or an on-host build longer than the fetch waits for a byte succeeds as a stream, and fails as one answer', async () => {
  const work: Promise<unknown>[] = [];

  await using harness = await setupImpTest();

  await using impd = startSlowOps(harness, 500, 25, (made) => {
    work.push(made);
  });

  const client = createImpClient({ url: impd.url, token: TEST_TOKEN, fetch: createIdleFetch(200) });
  const phases: ImageBuildPhase[] = [];

  // each stream is read as it opens: one left unread is silent, too
  const openStreams = [
    () => client.images.addStream({ ref: 'busybox:1.37', name: 'box' }),
    () => client.images.buildStream({ contextDir: '/srv/ctx', name: 'web' }),
  ];

  for (const openStream of openStreams) {
    const events = await openStream();

    for await (const event of events) {
      if (event.type === 'progress') {
        phases.push(event.phase);
      }
    }
  }

  expect(phases.filter((phase) => phase === 'pull').length).toBeGreaterThan(3);
  expect(phases.filter((phase) => phase === 'pack').length).toBeGreaterThan(3);

  const images = await client.images.list();

  expect(images.map((image) => image.name).toSorted()).toEqual(['box', 'web']);

  // the procedures that answer only at the end
  const failures = await Promise.all([
    client.images.add({ ref: 'busybox:1.37', name: 'box2' }).catch((error: unknown) => error),
    client.images.build({ contextDir: '/srv/ctx', name: 'web2' }).catch((error: unknown) => error),
  ]);

  expect(failures).toMatchObject([{ name: 'TimeoutError' }, { name: 'TimeoutError' }]);

  // impd still runs the two it was given; their images land
  await Promise.all(work);

  const after = await client.images.list();

  expect(after.map((image) => image.name).toSorted()).toEqual(['box', 'box2', 'web', 'web2']);
});
