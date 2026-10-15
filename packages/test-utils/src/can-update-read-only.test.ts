import { expect, test } from 'bun:test';
import { canUpdateReadOnly } from './can-update-read-only';

// root's lock as this machine allows it, asked of chattr directly; any other
// user's lock is a chmod, which needs nothing
test.skipIf(
  process.getuid?.() === 0 &&
    Bun.spawnSync([
      'sh',
      '-c',
      'd=$(mktemp -d) && chattr +i "$d" && chattr -i "$d"; s=$?; rm -rf "$d"; exit $s',
    ]).exitCode !== 0,
)('it answers yes where the run can lock a tree', () => {
  expect(canUpdateReadOnly()).toBeTrue();
});
