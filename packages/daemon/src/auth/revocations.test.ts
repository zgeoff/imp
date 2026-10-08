import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { createRevocations } from './revocations';

test('#readSignal gives a live signal for an id that was not revoked', () => {
  const revocations = createRevocations();
  const signal = revocations.readSignal('token-a');

  expect(signal?.aborted).toBeFalse();
});

test('#readSignal gives the same signal each time it is asked for one id', () => {
  const revocations = createRevocations();
  const first = revocations.readSignal('token-a');

  expect(revocations.readSignal('token-a')).toBe(first);
});

test('#readSignal gives no signal for a caller with no id', () => {
  const revocations = createRevocations();

  expect(revocations.readSignal(null)).toBeNull();
});

test('#revoke aborts the signal handed out before it', () => {
  const revocations = createRevocations();
  const before = revocations.readSignal('token-a');

  revocations.revoke('token-a');

  expect(before?.aborted).toBeTrue();
});

test('#revoke aborts every signal asked for after it, as for a socket that authenticated before', () => {
  const revocations = createRevocations();

  revocations.revoke('token-a');

  const after = revocations.readSignal('token-a');

  expect(after?.aborted).toBeTrue();
});

test('#revoke leaves another id’s signal live', () => {
  const revocations = createRevocations();
  const other = revocations.readSignal('token-b');

  revocations.revoke('token-a');

  invariant(other);

  expect(other.aborted).toBeFalse();
});

test('#isRevoked reports an id that was never revoked as live', () => {
  const revocations = createRevocations();

  expect(revocations.isRevoked('grant-a')).toBeFalse();
});

test('#isRevoked remembers a revoked id for the per-request check', () => {
  const revocations = createRevocations();

  revocations.revoke('grant-a');

  expect(revocations.isRevoked('grant-a')).toBeTrue();
});

test('#isRevoked keeps another id live after a revoke', () => {
  const revocations = createRevocations();

  revocations.revoke('grant-a');

  expect(revocations.isRevoked('grant-b')).toBeFalse();
});
