import { expect, test } from 'bun:test';
import { normalizePlatform, pickRepoDigest, toRepository } from './image-pin';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

test('the platform is os/arch with the architecture named as containerd names it', () => {
  expect(normalizePlatform('linux', 'amd64')).toBe('linux/amd64');
  expect(normalizePlatform('linux', 'x86_64')).toBe('linux/amd64');
  expect(normalizePlatform('Linux', 'aarch64')).toBe('linux/arm64');
  expect(normalizePlatform('linux', 'riscv64')).toBe('linux/riscv64');
  expect(() => normalizePlatform('linux', 'arm')).toThrow('not linux/arm');
  expect(() => normalizePlatform('windows', 'amd64')).toThrow('not windows/amd64');
});

test('a ref names its repository as RepoDigests writes it', () => {
  expect(toRepository('busybox:1.37')).toBe('busybox');
  expect(toRepository('docker.io/library/busybox:1.37')).toBe('busybox');
  expect(toRepository('index.docker.io/acme/app')).toBe('acme/app');
  expect(toRepository(`ghcr.io/acme/app:2@${DIGEST_A}`)).toBe('ghcr.io/acme/app');
  expect(toRepository('registry.test:5000/app:1')).toBe('registry.test:5000/app');
  expect(toRepository('localhost/app')).toBe('localhost/app');
  expect(toRepository('library/busybox')).toBe('library/busybox');
});

test('the pin is the ref’s own digest, else its repository’s, else any the image has', () => {
  const both = [`other.test/x@${DIGEST_B}`, `busybox@${DIGEST_A}`];

  expect(pickRepoDigest(`busybox:1.37@${DIGEST_B}`, both)).toBe(`busybox@${DIGEST_B}`);
  expect(pickRepoDigest('docker.io/library/busybox:1.37', both)).toBe(`busybox@${DIGEST_A}`);
  expect(pickRepoDigest('imp/retag:1', both)).toBe(`other.test/x@${DIGEST_B}`);
  expect(pickRepoDigest('imp/local:1', [])).toBeNull();
});
