import { expect, test } from 'bun:test';
import { setupTestDatabase } from '../test-utils/create-test-database';
import { createImp } from './imps';
import { isImpSetWrite } from './is-imp-set-write';

test('a create, a destroy and a stop resync the proxy and the grants; a sleep does not', async () => {
  await using ctx = await setupTestDatabase();

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: ctx.image.id,
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
