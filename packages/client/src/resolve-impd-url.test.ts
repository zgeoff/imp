import { expect, test } from 'bun:test';
import { resolveImpdUrl } from './resolve-impd-url';

test('it appends the path to the base', () => {
  expect(resolveImpdUrl('http://localhost:7070', '/rpc').href).toBe('http://localhost:7070/rpc');
});

test('it keeps a path prefix, with or without a trailing slash', () => {
  expect(resolveImpdUrl('https://host/impd/', '/rpc').href).toBe('https://host/impd/rpc');
  expect(resolveImpdUrl('https://host/impd', '/exec').href).toBe('https://host/impd/exec');
});

test('it drops a query and a fragment from the base', () => {
  expect(resolveImpdUrl('http://host/?a=1#x', '/rpc').href).toBe('http://host/rpc');
});
