import { expect, onTestFinished, test } from 'bun:test';
import { chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { utils } from 'ssh2';
import { createAuthorizedKeys, formatKeyFingerprint, parseAuthorizedKeys } from './authorized-keys';
import { createEd25519Key } from './host-key';

// An owner-only dir for authorized_keys, which the test writes.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-keys-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);

  return { dir, keysPath: join(dir, 'authorized_keys') };
}

test('it reads a key line with its type and comment', () => {
  const key = createEd25519Key().public;
  const parsed = parseAuthorizedKeys(`# laptop\n\n${key} me@laptop\n`);

  expect(parsed.keys).toStrictEqual([
    {
      type: 'ssh-ed25519',
      blob: expect.toSatisfy((blob: unknown) => Buffer.isBuffer(blob)),
      comment: 'me@laptop',
      verify: expect.toBeFunction(),
    },
  ]);
});

test('it skips comments and blank lines without a problem', () => {
  const key = createEd25519Key().public;

  expect(parseAuthorizedKeys(`# laptop\n\n${key} me@laptop\n`).problems).toStrictEqual([]);
});

test('it reads a key’s blob in SSH wire format', () => {
  const key = createEd25519Key().public;
  const parsed = utils.parseKey(key);

  if (parsed instanceof Error) {
    throw parsed;
  }

  expect(parseAuthorizedKeys(key).keys[0]?.blob).toStrictEqual(parsed.getPublicSSH());
});

test.each([
  ['from=', 'from="10.0.0.1"'],
  ['command=', 'command="true"'],
  ['restrict', 'restrict'],
])(
  'it refuses a line that starts with the %s option, which it cannot enforce',
  (_option, prefix) => {
    const key = createEd25519Key().public;

    expect(parseAuthorizedKeys(`${prefix} ${key}`)).toStrictEqual({
      keys: [],
      problems: ['line 1: options are not supported; put the key type first'],
    });
  },
);

test.each(['sk-ssh-ed25519@openssh.com', 'ssh-dss'])(
  'it refuses a %s key, which the gateway cannot verify',
  (type) => {
    expect(parseAuthorizedKeys(`${type} AAAA me`)).toStrictEqual({
      keys: [],
      problems: [`line 1: ${type} keys are not supported`],
    });
  },
);

test('it refuses a key whose data does not parse, with ssh2’s reason', () => {
  const parsed = parseAuthorizedKeys('# a broken key\nssh-ed25519 bm90IGEga2V5 me\n');

  expect(parsed.keys).toStrictEqual([]);

  expect(parsed.problems).toStrictEqual([
    expect.toSatisfy((problem: string) => /^line 2: \S/v.test(problem)),
  ]);
});

test('it formats a fingerprint as ssh-keygen prints it', () => {
  // SHA-256 of the empty string, unpadded base64
  expect(formatKeyFingerprint(Buffer.alloc(0))).toBe(
    'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU',
  );
});

test('it finds a key that the file lists', async () => {
  const ctx = await setupTest();

  const key = createEd25519Key().public;
  const blob = parseAuthorizedKeys(key).keys[0]?.blob;

  invariant(blob);
  writeFileSync(ctx.keysPath, `${key} me\n`, { mode: 0o600 });

  const keys = createAuthorizedKeys(ctx.keysPath, () => {});

  expect(keys.findKey(blob)).toMatchObject({ type: 'ssh-ed25519', comment: 'me' });
});

test('it finds no key that the file does not list', async () => {
  const ctx = await setupTest();

  const other = parseAuthorizedKeys(createEd25519Key().public).keys[0]?.blob;

  invariant(other);
  writeFileSync(ctx.keysPath, `${createEd25519Key().public}\n`, { mode: 0o600 });

  const keys = createAuthorizedKeys(ctx.keysPath, () => {});

  expect(keys.findKey(other)).toBeNull();
});

test('it lists a key but grants none from a file that others can write', async () => {
  const ctx = await setupTest();

  const key = createEd25519Key().public;
  const blob = parseAuthorizedKeys(key).keys[0]?.blob;

  invariant(blob);
  writeFileSync(ctx.keysPath, `${key}\n`, { mode: 0o600 });
  chmodSync(ctx.keysPath, 0o666);

  const keys = createAuthorizedKeys(ctx.keysPath, () => {});

  expect(keys.findKey(blob)).toBeNull();
  expect(keys.isListed(blob)).toBeTrue();
});

test('it grants no key from a file whose directory others can write', async () => {
  const ctx = await setupTest();

  const key = createEd25519Key().public;
  const blob = parseAuthorizedKeys(key).keys[0]?.blob;
  const logs: string[] = [];

  invariant(blob);
  writeFileSync(ctx.keysPath, `${key}\n`, { mode: 0o600 });
  chmodSync(ctx.dir, 0o777);

  const keys = createAuthorizedKeys(ctx.keysPath, (message) => {
    logs.push(message);
  });

  expect(keys.findKey(blob)).toBeNull();

  expect(logs).toStrictEqual([
    `impd: ssh: ${ctx.dir} is writable by group or others; no key can log in until it is not`,
  ]);
});

test('it logs that no key can log in when the file is missing', async () => {
  const ctx = await setupTest();

  const blob = parseAuthorizedKeys(createEd25519Key().public).keys[0]?.blob;
  const logs: string[] = [];

  invariant(blob);

  const keys = createAuthorizedKeys(ctx.keysPath, (message) => {
    logs.push(message);
  });

  expect(keys.findKey(blob)).toBeNull();
  expect(logs).toStrictEqual([`impd: ssh: no ${ctx.keysPath}; no key can log in`]);
});

test('it logs each line it skips with its problem', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  writeFileSync(ctx.keysPath, 'ssh-dss AAAA me\n', { mode: 0o600 });

  const keys = createAuthorizedKeys(ctx.keysPath, (message) => {
    logs.push(message);
  });

  keys.isListed(Buffer.alloc(0));

  expect(logs).toStrictEqual([
    `impd: ssh: ${ctx.keysPath} line 1: ssh-dss keys are not supported; skipped`,
  ]);
});

test('it reads the file again once it changes', async () => {
  const ctx = await setupTest();

  const key = createEd25519Key().public;
  const blob = parseAuthorizedKeys(key).keys[0]?.blob;
  const keys = createAuthorizedKeys(ctx.keysPath, () => {});

  invariant(blob);
  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  keys.isListed(blob);

  // an explicit new mtime, whatever the filesystem's clock granularity
  const later = new Date(Date.now() + 60_000);

  writeFileSync(ctx.keysPath, `${key}\n`, { mode: 0o600 });
  utimesSync(ctx.keysPath, later, later);

  expect(keys.findKey(blob)).not.toBeNull();
});

test('it reads the file once while it does not change', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  writeFileSync(ctx.keysPath, 'ssh-dss AAAA me\n', { mode: 0o600 });

  const keys = createAuthorizedKeys(ctx.keysPath, (message) => {
    logs.push(message);
  });

  keys.isListed(Buffer.alloc(0));
  keys.isListed(Buffer.alloc(0));

  expect(logs).toHaveLength(1);
});
