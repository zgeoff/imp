import { expect, test } from 'bun:test';
import { parseDomainHost } from './parse-domain-host';

const DOMAIN = 'imp.example.com';

test('one label in front of the domain names an imp', () => {
  expect(parseDomainHost('box.imp.example.com', DOMAIN)).toEqual({ kind: 'imp', name: 'box' });
  expect(parseDomainHost('Box.IMP.example.com.:443', DOMAIN)).toEqual({ kind: 'imp', name: 'box' });
});

test('the bare domain is the API, never an imp named after its first label', () => {
  expect(parseDomainHost('imp.example.com', DOMAIN)).toEqual({ kind: 'apex' });
  expect(parseDomainHost('imp.example.com:8443', DOMAIN)).toEqual({ kind: 'apex' });
});

test('two labels in front of the domain name nothing', () => {
  expect(parseDomainHost('a.b.imp.example.com', DOMAIN)).toBeNull();
});

test('another domain, an address or no host names nothing', () => {
  expect(parseDomainHost('box.imp.localhost', DOMAIN)).toBeNull();
  expect(parseDomainHost('box.notimp.example.com', DOMAIN)).toBeNull();
  expect(parseDomainHost('boximp.example.com', DOMAIN)).toBeNull();
  expect(parseDomainHost('100.64.0.1', DOMAIN)).toBeNull();
  expect(parseDomainHost('[::1]:443', DOMAIN)).toBeNull();
  expect(parseDomainHost(null, DOMAIN)).toBeNull();
});

test('a label that is no imp name names nothing', () => {
  expect(parseDomainHost('-bad.imp.example.com', DOMAIN)).toBeNull();
});
