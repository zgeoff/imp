import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface MockEd25519Key {
  // the private key as an unencrypted OpenSSH key file holds it
  readonly privateKey: string;

  // the raw 32-byte seed, which an agent holds in memory
  readonly seed: Buffer;

  // the raw 32-byte public key
  readonly publicKey: Buffer;
}

function encodeString(value: Buffer | string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);

  length.writeUInt32BE(bytes.length);

  return Buffer.concat([length, bytes]);
}

// An ed25519 key that node makes, written out in the OpenSSH key format
// (PROTOCOL.key in OpenSSH) without ssh-keygen, whose versions differ in the
// formats they read; the seed comes from node, not from the file.
export function buildMockEd25519Key(
  overrides: Readonly<{ comment?: string }> = {},
): MockEd25519Key {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d ?? '', 'base64url');
  const publicKey = Buffer.from(jwk.x ?? '', 'base64url');
  const publicBlob = Buffer.concat([encodeString('ssh-ed25519'), encodeString(publicKey)]);
  const check = randomBytes(4);

  const section = Buffer.concat([
    check,
    check,
    encodeString('ssh-ed25519'),
    encodeString(publicKey),
    encodeString(Buffer.concat([seed, publicKey])),
    encodeString(overrides.comment ?? 'imp-e2e-key'),
  ]);

  // padded with 1, 2, 3, … to the 8-byte block of the "none" cipher
  const padding = Buffer.from(
    Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, index) => index + 1),
  );

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    encodeString('none'),
    encodeString('none'),
    encodeString(''),
    Buffer.from([0, 0, 0, 1]),
    encodeString(publicBlob),
    encodeString(Buffer.concat([section, padding])),
  ]);

  const lines = body.toString('base64').match(/.{1,70}/gv) ?? [];

  return {
    privateKey: [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...lines,
      '-----END OPENSSH PRIVATE KEY-----',
      '',
    ].join('\n'),
    seed,
    publicKey,
  };
}
