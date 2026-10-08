import { expect, test } from 'bun:test';
import {
  formatPinFailure,
  formatPlatform,
  normalizePlatform,
  pickRepoDigest,
  readImageStore,
  toRepository,
} from './image-pin';

test.each([
  ['linux', 'amd64', 'linux/amd64'],
  ['linux', 'x86_64', 'linux/amd64'],
  ['Linux', 'X86-64', 'linux/amd64'],
  ['linux', 'aarch64', 'linux/arm64'],
  ['linux', 'i686', 'linux/386'],
  ['windows', 'arm', 'windows/arm'],
])('#formatPlatform formats %s and %s as the platform %s', (os, architecture, platform) => {
  expect(formatPlatform(os, architecture)).toBe(platform);
});

test.each([
  ['linux', 'amd64', 'linux/amd64'],
  ['linux', 'x86_64', 'linux/amd64'],
  ['Linux', 'aarch64', 'linux/arm64'],
  ['linux', 'riscv64', 'linux/riscv64'],
])(
  '#normalizePlatform normalizes the engine platform %s and %s to %s',
  (os, architecture, platform) => {
    expect(normalizePlatform(os, architecture)).toBe(platform);
  },
);

test.each([
  ['linux', 'arm', 'linux/arm'],
  ['windows', 'amd64', 'windows/amd64'],
])(
  '#normalizePlatform refuses to build on the engine platform %s and %s',
  (os, architecture, named) => {
    expect(() => normalizePlatform(os, architecture)).toThrowWithMessage(
      Error,
      `impd builds images on linux hosts other than 32-bit arm, not ${named}`,
    );
  },
);

test.each([
  ['busybox:1.37', 'busybox'],
  ['docker.io/library/busybox:1.37', 'busybox'],
  ['index.docker.io/acme/app', 'acme/app'],
  [`ghcr.io/acme/app:2@sha256:${'a'.repeat(64)}`, 'ghcr.io/acme/app'],
  ['registry.test:5000/app:1', 'registry.test:5000/app'],
  ['localhost/app', 'localhost/app'],
  ['LocalHost/app:1', 'LocalHost/app'],
  ['library/busybox', 'library/busybox'],
])(
  '#toRepository names the repository of %s as %s, as RepoDigests writes it',
  (ref, repository) => {
    expect(toRepository(ref)).toBe(repository);
  },
);

test('#pickRepoDigest pins a ref by its own digest when it names one', () => {
  expect(
    pickRepoDigest(`busybox:1.37@sha256:${'b'.repeat(64)}`, [
      `other.test/x@sha256:${'b'.repeat(64)}`,
      `busybox@sha256:${'a'.repeat(64)}`,
    ]),
  ).toBe(`busybox@sha256:${'b'.repeat(64)}`);
});

test('#pickRepoDigest pins a ref by its repository digest when the ref names no digest', () => {
  expect(
    pickRepoDigest('docker.io/library/busybox:1.37', [
      `other.test/x@sha256:${'b'.repeat(64)}`,
      `busybox@sha256:${'a'.repeat(64)}`,
    ]),
  ).toBe(`busybox@sha256:${'a'.repeat(64)}`);
});

test('#pickRepoDigest pins a retag by any digest the image has when its repository has none', () => {
  expect(
    pickRepoDigest('imp/retag:1', [
      `other.test/x@sha256:${'b'.repeat(64)}`,
      `busybox@sha256:${'a'.repeat(64)}`,
    ]),
  ).toBe(`other.test/x@sha256:${'b'.repeat(64)}`);
});

test('#pickRepoDigest finds no pin for an image with no registry digest', () => {
  expect(pickRepoDigest('imp/local:1', [])).toBeNull();
});

test('#readImageStore reads the containerd store when the image ID is one of its RepoDigests', () => {
  expect(
    readImageStore({
      Id: `sha256:${'a'.repeat(64)}`,
      RepoDigests: [`busybox@sha256:${'a'.repeat(64)}`],
      Os: 'linux',
      Architecture: 'amd64',
      OnBuild: null,
    }),
  ).toBe('containerd');
});

test('#readImageStore reads the classic store when the image ID is none of its RepoDigests', () => {
  expect(
    readImageStore({
      Id: `sha256:${'b'.repeat(64)}`,
      RepoDigests: [`busybox@sha256:${'a'.repeat(64)}`],
      Os: 'linux',
      Architecture: 'amd64',
      OnBuild: null,
    }),
  ).toBe('classic');
});

test('#readImageStore reads an unknown store for an image with no RepoDigests', () => {
  expect(
    readImageStore({
      Id: `sha256:${'b'.repeat(64)}`,
      RepoDigests: null,
      Os: 'linux',
      Architecture: 'amd64',
      OnBuild: null,
    }),
  ).toBe('unknown');
});

test('#formatPinFailure adds the retag hint to a denied pull of a pinned build', () => {
  expect(
    formatPinFailure('pull access denied, repository does not exist', [
      { use: 'FROM', ref: 'imp/retag:1', pin: `imp/retag@sha256:${'a'.repeat(64)}` },
    ]),
  ).toBe(
    `pull access denied, repository does not exist\nimpd pinned FROM imp/retag:1 as imp/retag@sha256:${'a'.repeat(64)}. On the containerd image store a retag of a multi-platform image cannot be pinned: build FROM its original repository, such as busybox:1.37, instead of the retag.`,
  );
});

test('#formatPinFailure leaves a failure that is no denied pull as it is', () => {
  expect(
    formatPinFailure('exit code 1', [
      { use: 'FROM', ref: 'imp/retag:1', pin: `imp/retag@sha256:${'a'.repeat(64)}` },
    ]),
  ).toBe('exit code 1');
});

test('#formatPinFailure leaves a denied pull of a build with no pins as it is', () => {
  expect(formatPinFailure('pull access denied', [])).toBe('pull access denied');
});
