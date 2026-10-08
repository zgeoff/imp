import { expect, test } from 'bun:test';
import { findRequestRoute, formatQuery, parseQuery } from './router';

test.each([
  ['HEAD', '/_ping', { kind: 'ping' }],
  ['GET', '/_ping', { kind: 'ping' }],
  ['GET', '/v1.55/version', { kind: 'version' }],
  [
    'GET',
    '/v1.55/images/docker.io/library/busybox:latest/json',
    { kind: 'image-inspect', name: 'docker.io/library/busybox:latest' },
  ],
  ['POST', '/v1.55/images/create?fromImage=busybox&tag=latest', { kind: 'pull' }],
  ['POST', '/v1.55/build?t=imp%2Fx%3Alatest&version=2', { kind: 'build' }],
  ['POST', '/v1.55/containers/create', { kind: 'create' }],
  ['POST', '/containers/create', { kind: 'create' }],
  ['GET', `/v1.55/containers/${'a'.repeat(64)}/export`, { kind: 'export', id: 'a'.repeat(64) }],
  ['DELETE', `/v1.55/containers/${'a'.repeat(64)}?force=1`, { kind: 'remove', id: 'a'.repeat(64) }],
])('#findRequestRoute routes %s %s, a call impd makes', (method, target, route) => {
  const routed = findRequestRoute(method, target);

  expect(routed as unknown).toStrictEqual({
    isAllowed: true,
    request: {
      versionPrefix: expect.any(String) as unknown,
      route,
      query: expect.any(Map) as unknown,
    },
  });
});

test('#findRequestRoute keeps the version prefix and every query value', () => {
  expect(findRequestRoute('POST', '/v1.55/images/create?fromImage=busybox&tag=1')).toStrictEqual({
    isAllowed: true,
    request: {
      versionPrefix: '/v1.55',
      route: { kind: 'pull' },
      query: new Map([
        ['fromImage', ['busybox']],
        ['tag', ['1']],
      ]),
    },
  });
});

test('#findRequestRoute routes a call with no version prefix under an empty prefix', () => {
  expect(findRequestRoute('GET', '/version')).toStrictEqual({
    isAllowed: true,
    request: { versionPrefix: '', route: { kind: 'version' }, query: new Map() },
  });
});

test.each([
  ['POST', `/v1.55/containers/${'a'.repeat(64)}/start`, `/containers/${'a'.repeat(64)}/start`],
  ['POST', `/v1.55/containers/${'a'.repeat(64)}/exec`, `/containers/${'a'.repeat(64)}/exec`],
  ['POST', `/v1.55/containers/${'a'.repeat(64)}/attach`, `/containers/${'a'.repeat(64)}/attach`],
  ['GET', '/v1.55/containers/json', '/containers/json'],
  ['POST', '/v1.55/images/load', '/images/load'],
  ['POST', '/v1.55/images/busybox/tag', '/images/busybox/tag'],
  ['DELETE', '/v1.55/images/busybox', '/images/busybox'],
  ['POST', '/v1.55/session', '/session'],
  ['POST', '/session', '/session'],
  ['POST', '/v1.55/grpc', '/grpc'],
  ['POST', '/grpc', '/grpc'],
  ['POST', '/v1.55/volumes/create', '/volumes/create'],
  ['POST', '/v1.55/plugins/pull', '/plugins/pull'],
  ['GET', '/v1.55/build', '/build'],
  ['PUT', `/v1.55/containers/${'a'.repeat(64)}/archive`, `/containers/${'a'.repeat(64)}/archive`],
  ['POST', '/v1.55/swarm/init', '/swarm/init'],
  ['GET', '/v1.55/images/-x/json', '/images/-x/json'],
  ['POST', '/v1.55/v1.55/containers/create', '/v1.55/containers/create'],
])('#findRequestRoute refuses %s %s, a call impd does not make', (method, target, path) => {
  expect(findRequestRoute(method, target)).toStrictEqual({
    isAllowed: false,
    reason: `${method} ${path} is not a call impd makes`,
  });
});

test('#findRequestRoute refuses an HTTP/2 preface target as not a plain path', () => {
  expect(findRequestRoute('PRI', '*')).toStrictEqual({
    isAllowed: false,
    reason: 'path "*" is not a plain path',
  });
});

// one spelling is checked and forwarded: an escape, a dot segment or an
// empty segment is refused, never normalised
test.each([
  ['/v1.55/containers/x%2F..%2F..%2Fstart/export'],
  ['/v1.55/containers/x/../y/export'],
  ['/v1.55//containers/create'],
  ['/v1.55/containers/./create'],
  [String.raw`/v1.55\containers\create`],
  ['v1.55/containers/create'],
])('#findRequestRoute refuses the path %s, which is not plain', (target) => {
  expect(findRequestRoute('POST', target)).toStrictEqual({
    isAllowed: false,
    reason: `path ${JSON.stringify(target)} is not a plain path`,
  });
});

test('#parseQuery keeps every value of a repeated param, in order', () => {
  expect(parseQuery('t=a&q=1&t=b')).toStrictEqual(
    new Map([
      ['t', ['a', 'b']],
      ['q', ['1']],
    ]),
  );
});

test('#formatQuery writes each value of a param in order', () => {
  const query = new Map([
    ['t', ['a', 'b']],
    ['q', ['1']],
  ]);

  expect(formatQuery(query)).toBe('?t=a&t=b&q=1');
});

test('#formatQuery writes nothing for no params', () => {
  expect(formatQuery(new Map())).toBe('');
});
