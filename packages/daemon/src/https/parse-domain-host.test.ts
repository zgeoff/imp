import { expect, test } from 'bun:test';
import { parseDomainHost } from './parse-domain-host';

test.each([['box.imp.example.com'], ['Box.IMP.example.com.:443']])(
  'it names an imp for one label in front of the domain in %s',
  (host) => {
    expect(parseDomainHost(host, 'imp.example.com')).toStrictEqual({ kind: 'imp', name: 'box' });
  },
);

test.each([['imp.example.com'], ['imp.example.com:8443']])(
  'it names the API, never an imp, for the bare domain %s',
  (host) => {
    expect(parseDomainHost(host, 'imp.example.com')).toStrictEqual({ kind: 'apex' });
  },
);

test.each([
  ['a.b.imp.example.com', 'two labels in front of the domain'],
  ['box.imp.localhost', 'another domain'],
  ['box.notimp.example.com', 'a domain that only ends with the same text'],
  ['boximp.example.com', 'a label joined to the domain'],
  ['100.64.0.1', 'an IPv4 address'],
  ['[::1]:443', 'an IPv6 address'],
  ['-bad.imp.example.com', 'a label that is no imp name'],
])('it names nothing for %s, %s', (host) => {
  expect(parseDomainHost(host, 'imp.example.com')).toBeNull();
});

test('it names nothing when there is no host', () => {
  expect(parseDomainHost(null, 'imp.example.com')).toBeNull();
});
