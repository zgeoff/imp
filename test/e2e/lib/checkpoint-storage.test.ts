import { expect, test } from 'bun:test';
import { hasLiveSnapshot } from './checkpoint-storage';

test('#hasLiveSnapshot finds the checkpoint’s snapshot not marked for destroy', () => {
  const listing = 'tank/imp/imps/a1@cp-2\toff\ntank/imp/imps/a1@cp-1\toff\n';

  expect(hasLiveSnapshot(listing, 'cp-1')).toBeTrue();
});

test('#hasLiveSnapshot passes over a snapshot marked for destroy', () => {
  expect(hasLiveSnapshot('tank/imp/imps/a1@cp-1\ton\n', 'cp-1')).toBeFalse();
});

test('#hasLiveSnapshot matches the whole checkpoint id, not its tail', () => {
  expect(hasLiveSnapshot('tank/imp/imps/a1@xcp-1\toff\n', 'cp-1')).toBeFalse();
});
