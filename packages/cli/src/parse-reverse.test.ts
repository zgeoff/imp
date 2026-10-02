import { expect, test } from 'bun:test';
import { listReverseSpecs, parseReverse } from './parse-reverse';

test('each side is a path or a port, and a lone side is both', () => {
  expect(parseReverse('/tmp/atc.sock:/Users/me/.atc/atc.sock')).toEqual({
    guest: { network: 'unix', path: '/tmp/atc.sock' },
    local: { network: 'unix', path: '/Users/me/.atc/atc.sock' },
  });

  expect(parseReverse('9000:8080')).toEqual({
    guest: { network: 'tcp', port: 9000 },
    local: { network: 'tcp', port: 8080 },
  });

  expect(parseReverse('9000')).toEqual({
    guest: { network: 'tcp', port: 9000 },
    local: { network: 'tcp', port: 9000 },
  });

  expect(parseReverse('0:/run/app.sock')).toEqual({
    guest: { network: 'tcp', port: 0 },
    local: { network: 'unix', path: '/run/app.sock' },
  });
});

test('an empty guest side is a socket the agent makes, and a local path may hold a colon', () => {
  expect(parseReverse(':/tmp/a:b.sock')).toEqual({
    guest: { network: 'unix', path: null },
    local: { network: 'unix', path: '/tmp/a:b.sock' },
  });
});

test('anything else is a usage error', () => {
  for (const spec of [
    '',
    'app.sock:/x',
    '70000:80',
    '9000:0',
    '9000:host:80',
    'x',
    '/a.sock:rel',
  ]) {
    expect(() => parseReverse(spec)).toThrow(`not a reverse forward: ${spec}`);
  }
});

test('a repeated --reverse keeps every value', () => {
  expect(listReverseSpecs(['box', '--reverse', '/a:/b', '5432', '--reverse=9000'])).toEqual([
    '/a:/b',
    '9000',
  ]);
});
