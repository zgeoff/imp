import { expect, test } from 'bun:test';
import {
  findRepoDigest,
  findUnpinnedRequests,
  parseManifestRequests,
  parsePublishedPort,
} from './registry-steps';

test('#parsePublishedPort reads the first published host port', () => {
  expect(parsePublishedPort('127.0.0.1:49153\n[::1]:49154\n')).toBe('49153');
});

test('#parsePublishedPort fails on output with no port', () => {
  expect(() => parsePublishedPort('')).toThrowWithMessage(Error, 'no published port in ""');
});

test('#parseManifestRequests reads the repository’s manifest references in order', () => {
  const logs = [
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/manifests/1"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/other/manifests/1"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/manifests/sha256:abc"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/blobs/sha256:def"',
  ].join('\n');

  expect(parseManifestRequests(logs, 'e2e/mutable')).toStrictEqual(['1', 'sha256:abc']);
});

test('#findRepoDigest picks the digest under the repository', () => {
  const digests = JSON.stringify(['mirror.test/busybox@sha256:aaa', 'busybox@sha256:bbb']);

  expect(findRepoDigest(digests, 'busybox')).toBe('busybox@sha256:bbb');
});

test('#findRepoDigest fails when no digest is under the repository', () => {
  expect(() => findRepoDigest('["mirror.test/busybox@sha256:aaa"]', 'busybox')).toThrowWithMessage(
    Error,
    'no RepoDigest under busybox in ["mirror.test/busybox@sha256:aaa"]',
  );
});

test('#findUnpinnedRequests keeps every reference but the pin’s digest', () => {
  expect(
    findUnpinnedRequests('reg.test:5000/e2e/mutable@sha256:abc', ['sha256:abc', '1', 'sha256:abc']),
  ).toStrictEqual(['1']);
});
