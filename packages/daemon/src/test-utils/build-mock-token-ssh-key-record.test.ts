import { expect, test } from 'bun:test';
import { formatKeyFingerprint } from '../ssh/authorized-keys';
import { buildMockTokenSshKeyRecord } from './build-mock-token-ssh-key-record';

test('it builds a default token ssh key record', () => {
  const record = buildMockTokenSshKeyRecord();
  const [, data = ''] = record.publicKey.split(' ');
  const blob = Buffer.from(data, 'base64');

  expect(record).toStrictEqual({
    id: expect.toBeString(),
    tokenId: expect.toBeString(),
    fingerprint: formatKeyFingerprint(blob),
    publicKey: expect.toStartWith('ssh-ed25519 AAAA'),
    comment: expect.toBeString(),
    createdAt: expect.toBeValidDate(),
  });
});

test('it applies overrides on top of the defaults', () => {
  const record = buildMockTokenSshKeyRecord({
    id: 'key-1',
    tokenId: 'abcdefghijklmnop',
    fingerprint: 'SHA256:abc',
    publicKey: 'ssh-ed25519 !!!',
    comment: 'me@laptop',
    createdAt: new Date(1_800_000_000_000),
  });

  expect(record).toStrictEqual({
    id: 'key-1',
    tokenId: 'abcdefghijklmnop',
    fingerprint: 'SHA256:abc',
    publicKey: 'ssh-ed25519 !!!',
    comment: 'me@laptop',
    createdAt: new Date(1_800_000_000_000),
  });
});
