import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { getLibc, getPidfdLibc, readErrno } from './libc';

test('#getLibc opens libc once', () => {
  expect(getLibc()).toBe(getLibc());
});

test('#getLibc gives lseek, which reports EBADF for a closed descriptor', () => {
  const libc = getLibc();

  invariant(libc);

  const result = Number(libc.lseek(-1, 0, 0));

  expect(result).toBe(-1);

  // EBADF on Linux
  expect(readErrno()).toBe(9);
});

test('#getPidfdLibc opens the pidfd wrappers once', () => {
  expect(getPidfdLibc()).toBe(getPidfdLibc());
});
