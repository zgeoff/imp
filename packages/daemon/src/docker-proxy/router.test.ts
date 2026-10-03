import { expect, test } from 'bun:test';
import { findRequestRoute, formatQuery, parseQuery } from './router';

const ID = 'a'.repeat(64);

function findKind(method: string, target: string): string {
  const routed = findRequestRoute(method, target);

  return routed.isAllowed ? routed.request.route.kind : 'refused';
}

test('every call impd makes finds its route, with or without a version prefix', () => {
  expect(findKind('HEAD', '/_ping')).toBe('ping');
  expect(findKind('GET', '/v1.55/version')).toBe('version');

  expect(findKind('GET', '/v1.55/images/docker.io/library/busybox:latest/json')).toBe(
    'image-inspect',
  );

  expect(findKind('POST', '/v1.55/images/create?fromImage=busybox&tag=latest')).toBe('pull');
  expect(findKind('POST', '/v1.55/build?t=imp%2Fx%3Alatest&version=2')).toBe('build');
  expect(findKind('POST', '/v1.55/containers/create')).toBe('create');
  expect(findKind('GET', `/v1.55/containers/${ID}/export`)).toBe('export');
  expect(findKind('DELETE', `/v1.55/containers/${ID}?force=1`)).toBe('remove');
});

test('a call impd does not make is refused', () => {
  for (const [method, target] of [
    ['POST', `/v1.55/containers/${ID}/start`],
    ['POST', `/v1.55/containers/${ID}/exec`],
    ['POST', `/v1.55/containers/${ID}/attach`],
    ['GET', '/v1.55/containers/json'],
    ['POST', '/v1.55/images/load'],
    ['POST', '/v1.55/images/busybox/tag'],
    ['DELETE', '/v1.55/images/busybox'],
    ['POST', '/v1.55/session'],
    ['POST', '/session'],
    ['POST', '/v1.55/grpc'],
    ['POST', '/grpc'],
    ['PRI', '*'],
    ['POST', '/v1.55/volumes/create'],
    ['POST', '/v1.55/plugins/pull'],
    ['GET', '/v1.55/build'],
    ['PUT', `/v1.55/containers/${ID}/archive`],
    ['POST', '/v1.55/swarm/init'],
  ] as const) {
    expect(findKind(method, target)).toBe('refused');
  }
});

test('a path with an escape, a dot segment or an empty segment is refused, not normalised', () => {
  for (const target of [
    '/v1.55/containers/x%2F..%2F..%2Fstart/export',
    '/v1.55/containers/x/../y/export',
    '/v1.55//containers/create',
    '/v1.55/containers/./create',
    String.raw`/v1.55\containers\create`,
    'v1.55/containers/create',
  ]) {
    expect(findKind('POST', target)).toBe('refused');
  }
});

test('only one version prefix is stripped', () => {
  expect(findKind('POST', '/v1.55/v1.55/containers/create')).toBe('refused');
});

test('a query keeps every value of a repeated param, in order', () => {
  const query = parseQuery('t=a&q=1&t=b');

  expect(query.get('t')).toEqual(['a', 'b']);
  expect(formatQuery(query)).toBe('?t=a&t=b&q=1');
  expect(formatQuery(new Map())).toBe('');
});
