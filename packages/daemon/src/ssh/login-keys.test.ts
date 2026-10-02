import { expect, test } from 'bun:test';
import { formatKeyFingerprint, parsePublicKey } from './authorized-keys';
import { createEd25519Key } from './host-key';
import { createLoginKeys } from './login-keys';

function parseKey(line: string) {
  const key = parsePublicKey(line);

  if (typeof key === 'string') {
    throw new TypeError(key);
  }

  return key;
}

test('a file key is its own principal, by fingerprint, shown by its comment', () => {
  const key = parseKey(`${createEd25519Key().public} me@desk`);

  const keys = createLoginKeys({
    findBound: () => null,
    file: { findKey: () => key, isListed: () => true },
  });

  expect(keys.findKey(key.blob)?.caller).toMatchObject({
    kind: 'ssh',
    name: 'key me@desk',
    principal: `key:${formatKeyFingerprint(key.blob)}`,
    display: 'me@desk',
  });
});
