import { expect, test } from 'bun:test';
import { createRevocations } from './revocations';

test('a removal aborts the token’s signal, and every signal asked for after it', () => {
  const revocations = createRevocations();
  const before = revocations.readSignal('a');
  const other = revocations.readSignal('b');

  revocations.revoke('a');

  // a socket that authenticated before the removal registers after it
  const after = revocations.readSignal('a');

  expect(before?.aborted).toBeTrue();
  expect(after?.aborted).toBeTrue();
  expect(other?.aborted).toBeFalse();
  expect(revocations.readSignal(null)).toBeNull();
});
