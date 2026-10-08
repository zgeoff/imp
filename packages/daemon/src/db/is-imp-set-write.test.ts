import { expect, test } from 'bun:test';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createImage } from './images';
import { createImp } from './imps';
import { isImpSetWrite } from './is-imp-set-write';

test('a create, a destroy and a stop resync the proxy and the grants; a sleep does not', async () => {
  const ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 2,
    memoryMib: 2048,
    slot: 0,
    ip: '10.66.0.2',
  });

  expect(isImpSetWrite({ kind: 'added', imp })).toBeTrue();
  expect(isImpSetWrite({ kind: 'removed', imp })).toBeTrue();
  expect(isImpSetWrite({ kind: 'changed', imp, reason: 'stopped' })).toBeTrue();
  expect(isImpSetWrite({ kind: 'changed', imp, reason: 'slept' })).toBeFalse();
});
