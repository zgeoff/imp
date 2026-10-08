import { expect, test } from 'bun:test';
import { planRootfs, planRootfsOverhead } from './rootfs-plan';

test('#planRootfs plans at least 4 GiB for a small tree, with the default inode count', () => {
  expect(planRootfs({ bytes: 300 * 1024 ** 2, inodes: 20_000 })).toStrictEqual({
    bytes: 4 * 1024 ** 3,
    inodes: null,
  });
});

test('#planRootfs plans the tree plus a fifth and 2 GiB, rounded up to whole GiB', () => {
  expect(planRootfs({ bytes: 5 * 1024 ** 3, inodes: 90_000 })).toStrictEqual({
    bytes: 8 * 1024 ** 3,
    inodes: null,
  });
});

// node_modules: many small files need more inodes than 16 KiB each gives
test('#planRootfs plans twice the inodes of a tree of many small files', () => {
  expect(planRootfs({ bytes: 1024 ** 3, inodes: 400_000 })).toStrictEqual({
    bytes: 4 * 1024 ** 3,
    inodes: 800_000,
  });
});

test('#planRootfsOverhead holds at least 128 MiB for the rootfs own blocks', () => {
  expect(planRootfsOverhead(0)).toBe(128 * 1024 ** 2);
});

// the default image cap, 8 GiB, plans a 12 GiB rootfs
test('#planRootfsOverhead holds 1/64 of the rootfs for its own blocks past the minimum', () => {
  expect(planRootfsOverhead(8 * 1024 ** 3)).toBe(192 * 1024 ** 2);
});

test('#planRootfsOverhead holds 1/64 of a large rootfs for its own blocks', () => {
  expect(planRootfsOverhead(100 * 1024 ** 3)).toBe((122 * 1024 ** 3) / 64);
});
