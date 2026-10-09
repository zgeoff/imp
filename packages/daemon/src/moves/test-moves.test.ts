import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { findImageByName } from '../db/images';
import { buildImagePaths } from '../storage/data-layout';
import { buildStubZfsStorage } from '../test-utils/build-stub-zfs-storage';
import { MOVE_PATHS } from './move-header';
import {
  TARGET_URL,
  createMoveHosts,
  createUbuntuImage,
  createZfsUbuntuImage,
  setupMoveHosts,
} from './test-moves';

test('#setupMoveHosts moves a stopped imp from the source to the target', async () => {
  const hosts = await setupMoveHosts();

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await hosts.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await hosts.runMove('dev');
  const moved = await hosts.targetApp.client.imps.get({ name: 'dev' });

  expect(status).toMatchObject({ isDone: true, error: null });
  expect(moved.state).toBe('stopped');
  expect(hosts.commits).toStrictEqual(['dev']);
});

test('#setupMoveHosts hands its hook each request to the target, with both hosts', async () => {
  const paths: string[] = [];
  const isTarget: boolean[] = [];

  const hosts = await setupMoveHosts({
    hook: (request, forward, peers) => {
      paths.push(new URL(request.url).pathname);
      isTarget.push(peers.target === hosts.target && peers.sourceApp === hosts.sourceApp);

      return forward();
    },
  });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await hosts.sourceApp.client.imps.stop({ name: 'dev' });
  await hosts.runMove('dev');

  expect(paths).toStrictEqual([
    MOVE_PATHS.offer,
    MOVE_PATHS.receive,
    MOVE_PATHS.receive,
    MOVE_PATHS.commit,
  ]);

  expect(isTarget).toStrictEqual([true, true, true, true]);
});

test('#setupMoveHosts sends the request a hook forwards in place of the one sent', async () => {
  const hosts = await setupMoveHosts({
    hook: (request, forward) =>
      request.url.endsWith(MOVE_PATHS.offer)
        ? forward(new Request(`${TARGET_URL}/move/nowhere`, { method: 'POST' }))
        : forward(),
  });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await hosts.sourceApp.client.imps.stop({ name: 'dev' });

  const status = await hosts.runMove('dev');

  expect(status.error).toBe('offer: the target answered 404 not found');
});

test('#createMoveHosts gives up waiting for a move that never ends', async () => {
  const held = Promise.withResolvers<undefined>();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await createMoveHosts(stack, {
    moveTimeoutMs: 50,
    hook: async (request, forward) => {
      if (request.url.endsWith(MOVE_PATHS.receive)) {
        await held.promise;
      }

      return forward();
    },
  });

  // the held send ends before the hosts go
  stack.defer(async () => {
    held.resolve(undefined);

    await hosts.sourceApp.client.moves.abort({ name: 'dev' });
  });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  await hosts.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await hosts.sourceApp.client.imps.stop({ name: 'dev' });

  expect(hosts.runMove('dev')).rejects.toThrowWithMessage(Error, 'the move of dev never ended');
});

test('#setupMoveHosts reports the target warm facts on both hosts when shared', async () => {
  const hosts = await setupMoveHosts({ isShared: true });
  const source = await hosts.sourceApp.client.moves.facts();
  const target = await hosts.targetApp.client.moves.facts();

  expect(source).toStrictEqual(target);
});

test('#setupMoveHosts reports each host its own warm facts when not shared', async () => {
  const hosts = await setupMoveHosts();
  const source = await hosts.sourceApp.client.moves.facts();
  const target = await hosts.targetApp.client.moves.facts();

  expect(source).not.toStrictEqual(target);
});

test('#setupMoveHosts removes both data dirs once the test ends', async () => {
  const hosts = await setupMoveHosts();

  onTestFinished(() => {
    expect(existsSync(hosts.source.dataDir)).toBe(false);
    expect(existsSync(hosts.target.dataDir)).toBe(false);
  });

  expect(existsSync(hosts.source.dataDir)).toBe(true);
});

test('#createMoveHosts releases both hosts with the stack it was given', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = await createMoveHosts(stack);

  await stack.disposeAsync();

  expect(existsSync(hosts.source.dataDir)).toBe(false);
  expect(existsSync(hosts.target.dataDir)).toBe(false);
});

test('#createUbuntuImage makes the ubuntu image with the config a create reads', async () => {
  const hosts = await setupMoveHosts();

  await createUbuntuImage(hosts.source);

  const image = await findImageByName(hosts.source.db, 'ubuntu');

  expect(image?.digest).toBe('sha256:ubuntu');

  expect(readFileSync(buildImagePaths(hosts.source.dataDir, 'sha256:ubuntu').config, 'utf8')).toBe(
    '{}',
  );
});

test('#createZfsUbuntuImage makes the ubuntu image as a dataset on the pool', async () => {
  const zfs = buildStubZfsStorage('tank/imp');

  const hosts = await setupMoveHosts({ source: { createStorage: zfs.createStorage } });

  await createZfsUbuntuImage(hosts.source);

  const image = await findImageByName(hosts.source.db, 'ubuntu');

  expect(image?.digest).toBe('sha256:ubuntu');
  expect(zfs.readPool().listDatasets()).toContain('tank/imp/images/ubuntu');

  expect(readFileSync(buildImagePaths(hosts.source.dataDir, 'sha256:ubuntu').rootfs, 'utf8')).toBe(
    'rootfs',
  );
});
