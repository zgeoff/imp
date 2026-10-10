import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { formatKeyFingerprint, parseAuthorizedKeys } from './authorized-keys';
import { createEd25519Key } from './host-key';
import { createLoginKeys } from './login-keys';

test('it logs a file key in as its own principal, by fingerprint, shown by its comment', () => {
  const [key] = parseAuthorizedKeys(`${createEd25519Key().public} me@desk`).keys;

  invariant(key);

  const keys = createLoginKeys({
    findBound: () => null,
    file: { findKey: () => key, isListed: () => true },
  });

  expect(keys.findKey(key.blob)).toStrictEqual({
    key,
    keyId: null,
    caller: {
      kind: 'ssh',
      name: 'key me@desk',
      scope: 'manage',
      imps: null,
      grantable: [],
      tokenId: null,
      grantId: null,
      expiresAt: null,
      principal: `key:${formatKeyFingerprint(key.blob)}`,
      display: 'me@desk',
    },
  });
});

test('it shows a file key with no comment by its type', () => {
  const [key] = parseAuthorizedKeys(createEd25519Key().public).keys;

  invariant(key);

  const keys = createLoginKeys({
    findBound: () => null,
    file: { findKey: () => key, isListed: () => true },
  });

  expect(keys.findKey(key.blob)).toStrictEqual({
    key,
    keyId: null,
    caller: {
      kind: 'ssh',
      name: 'key ssh-ed25519',
      scope: 'manage',
      imps: null,
      grantable: [],
      tokenId: null,
      grantId: null,
      expiresAt: null,
      principal: `key:${formatKeyFingerprint(key.blob)}`,
      display: 'ssh-ed25519',
    },
  });
});

// the narrower grant holds even if someone adds the key to the file later
test('it logs a key bound to a token in as the token, even when the file lists it', () => {
  const [key] = parseAuthorizedKeys(createEd25519Key().public).keys;
  const caller = buildMockCaller({ kind: 'ssh', name: 'ci' });

  invariant(key);

  const keys = createLoginKeys({
    findBound: () => ({ key, keyId: 'key-1', caller }),
    file: { findKey: () => key, isListed: () => true },
  });

  expect(keys.findKey(key.blob)).toStrictEqual({ key, keyId: 'key-1', caller });
});

test('it finds no key that is neither bound nor in the file', () => {
  const keys = createLoginKeys({
    findBound: () => null,
    file: { findKey: () => null, isListed: () => false },
  });

  expect(keys.findKey(Buffer.from('a key'))).toBeNull();
});

test('it finds no file key when authorized_keys is off', () => {
  const keys = createLoginKeys({ findBound: () => null, file: null });

  expect(keys.findKey(Buffer.from('a key'))).toBeNull();
});
