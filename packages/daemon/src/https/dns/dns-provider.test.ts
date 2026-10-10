import { expect, test } from 'bun:test';
import { buildPublicOwner } from './dns-provider';

test('it names the domain in the owner of its public imps’ records', () => {
  expect(buildPublicOwner('pub.example.com')).toBe('impd public imps of pub.example.com');
});

test('it names a domain too long for a Cloudflare comment by its hash', () => {
  const domain = `${'a'.repeat(63)}.${'b'.repeat(63)}.example.com`;

  // the first 32 hex digits of the domain's SHA-256, by `sha256sum`
  expect(buildPublicOwner(domain)).toBe(
    'impd public imps of sha256:423fc6404548453dabcdf5c9b8cbf3b9',
  );
});

test('it keeps every owner within Cloudflare’s 100 characters', () => {
  const domain = `${'a'.repeat(63)}.${'b'.repeat(63)}.example.com`;

  expect(buildPublicOwner(domain).length).toBeLessThanOrEqual(100);
});
