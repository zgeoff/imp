import { expect, test } from 'bun:test';
import { isRequestInFilter } from './is-request-in-filter';

test.each([
  ['GET', true],
  ['HEAD', true],
  ['POST', false],
  ['get', false],
])('it gives a filter of GET and HEAD the method %s: %p', (method, expected) => {
  expect(isRequestInFilter({ methods: ['GET', 'HEAD'] }, method, '/any/path')).toBe(expected);
});

test('it allows any method when the filter names paths only', () => {
  expect(isRequestInFilter({ paths: ['/v1/messages'] }, 'DELETE', '/v1/messages')).toBeTrue();
});

test('it allows any path when the filter names methods only', () => {
  expect(isRequestInFilter({ methods: ['GET'] }, 'GET', '/a/b%2Fc')).toBeTrue();
});

test.each([
  ['/v1/messages', '/v1/messages', true],
  ['/v1/messages', '/v1/messages/', false],
  ['/v1/messages', '/v1/messages-x', false],
  ['/v1/messages', '/v1', false],
  ['/', '/', true],
  ['/', '/v1', false],
  ['/repos/*/*/issues', '/repos/a/b/issues', true],
  ['/repos/*/*/issues', '/repos/a//issues', false],
  ['/repos/*/*/issues', '/repos/a/b/c/issues', false],
  ['/repos/*/*/issues', '/repos/a/b/pulls', false],
  ['/v1/**', '/v1', true],
  ['/v1/**', '/v1/', true],
  ['/v1/**', '/v1/a/b/c', true],
  ['/v1/**', '/v1x', false],
  ['/v1/**', '/v2/a', false],
  ['/**', '/anything/at/all', true],
  ['/repos/*/**', '/repos/a/b', true],
  ['/repos/*/**', '/repos', false],
])('it matches the pattern %s against the path %s: %p', (pattern, path, expected) => {
  expect(isRequestInFilter({ paths: [pattern] }, 'GET', path)).toBe(expected);
});

test('it allows a path that any one of the patterns matches', () => {
  expect(isRequestInFilter({ paths: ['/a', '/b/**'] }, 'GET', '/b/c')).toBeTrue();
});

test('it refuses a method outside the filter even when the path matches', () => {
  expect(isRequestInFilter({ methods: ['GET'], paths: ['/v1/**'] }, 'POST', '/v1/x')).toBeFalse();
});

test('it refuses a path outside the filter even when the method matches', () => {
  expect(isRequestInFilter({ methods: ['GET'], paths: ['/v1/**'] }, 'GET', '/v2/x')).toBeFalse();
});

test.each([['/repos/a%2F..%2Fadmin/x'], ['/repos/a%2f..%2fadmin/x'], ['/repos/a%5Cb/x']])(
  'it refuses the encoded separator in %s, which an upstream may decode to a new segment',
  (path) => {
    expect(isRequestInFilter({ paths: ['/repos/*/x'] }, 'GET', path)).toBeFalse();
  },
);
