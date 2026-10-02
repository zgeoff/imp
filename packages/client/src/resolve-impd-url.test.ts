import { expect, test } from 'bun:test';
import { resolveImpdUrl } from './resolve-impd-url';

test('it appends the path to a bare base', () => {
  expect(resolveImpdUrl('http://localhost:7070', '/rpc').href).toBe('http://localhost:7070/rpc');
});

test('it keeps a path prefix, with or without a trailing slash', () => {
  expect(resolveImpdUrl('https://host/imp', '/exec').href).toBe('https://host/imp/exec');
  expect(resolveImpdUrl('https://host/imp/', '/exec').href).toBe('https://host/imp/exec');
});

test('it keeps a query string a proxy may need', () => {
  expect(resolveImpdUrl('http://host:7070/?a=1', '/rpc').href).toBe('http://host:7070/rpc?a=1');
});
