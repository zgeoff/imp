import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createSecret, findSecret } from '../db/secrets';
import { removeTokenRecord, writeTokenRecord } from '../db/tokens';
import { formatKeyFingerprint } from '../ssh/authorized-keys';
import { createEd25519Key } from '../ssh/host-key';
import { buildMockTokenRecord } from '../test-utils/build-mock-token-record';
import { buildMockTokenSshKeyRecord } from '../test-utils/build-mock-token-ssh-key-record';
import { createTestDatabase } from '../test-utils/create-test-database';
import { ROOT_TOKEN_ID, loadTokenStore, readBearer } from './token-store';

async function setupTest() {
  const database = await createTestDatabase();

  const removed: string[] = [];

  // the blobs authorized_keys lists, in base64
  const fileKeys = new Set<string>();

  return {
    db: database.db,
    removed,
    fileKeys,

    // the store over this database, as impd loads it at each start
    load: (rootToken: string, now: () => number = Date.now) =>
      loadTokenStore({
        db: database.db,
        rootToken,
        now,
        onRemove: (id) => {
          removed.push(id);
        },
        isFileKey: (blob) => fileKeys.has(blob.toString('base64')),
      }),
  };
}

test('#authenticate takes the root token as root, with every scope and every imp', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.authenticate('root-secret')).toStrictEqual({
    kind: 'token',
    name: 'root',
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: ROOT_TOKEN_ID,
    grantId: null,
    expiresAt: null,
    principal: 'root',
    display: 'root',
  });
});

test('#findById finds root by its id, as a root dashboard session names it', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.findById(ROOT_TOKEN_ID)).toStrictEqual(tokens.authenticate('root-secret'));
});

test('#list leaves out the root token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.list()).toStrictEqual([]);
});

test('#create stores the secret only as its hash', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });
  const row = await ctx.db.selectFrom('tokens').selectAll().executeTakeFirstOrThrow();

  expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);

  const [, secret = made.secret] = made.secret.split('.');

  expect(JSON.stringify(row)).not.toInclude(secret);
});

test('#create gives the token and its secret once, as imp_<id>.<secret>', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret', () => 1_800_000_000_000);
  const made = await tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  expect(made).toStrictEqual({
    token: {
      name: 'ci',
      scope: 'exec',
      imps: ['dev-*'],
      grantable: [],
      sshKeys: [],
      createdAt: new Date(1_800_000_000_000),
    },
    secret: expect.toStartWith('imp_'),
  });

  expect(made.secret).toMatch(/^imp_[\w-]{16}\.[\w-]{43}$/);
});

test('#authenticate takes a made token’s secret after a restart', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret');
  const made = await before.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  const restarted = await ctx.load('root-secret');

  expect(restarted.authenticate(made.secret)).toStrictEqual({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
    tokenId,
    grantId: null,
    expiresAt: null,
    principal: `token:${tokenId}`,
    display: 'ci',
  });
});

test('#list lists a made token after a restart', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret', () => 1_800_000_000_000);

  await before.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const restarted = await ctx.load('root-secret');

  expect(restarted.list()).toStrictEqual([
    {
      name: 'ci',
      scope: 'exec',
      imps: ['dev-*'],
      sshKeys: [],
      grantable: [],
      createdAt: new Date(1_800_000_000_000),
    },
  ]);
});

test('#list sorts tokens by name', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'web', scope: 'read', imps: null });
  await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.list().map((token) => token.name)).toStrictEqual(['ci', 'web']);
});

test.each([
  ['', 'an empty secret'],
  ['root-secret ', 'the root token with a space added'],
  ['root-secre', 'the root token cut short'],
  ['imp_nosuchid000000.c2VjcmV0', 'a made token’s form with an unknown id'],
])('#authenticate takes nobody from %p, %s', async (secret) => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.authenticate(secret)).toBeNull();
});

test('#authenticate takes nobody from an unknown id with a made token’s real secret', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [, secret = ''] = made.secret.slice('imp_'.length).split('.');

  expect(tokens.authenticate(`imp_nosuchid00000000.${secret}`)).toBeNull();
});

test('#authenticate takes nobody from a made token with its secret changed', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [id] = made.secret.split('.');

  expect(tokens.authenticate(`${String(id)}.${'A'.repeat(43)}`)).toBeNull();
});

test('#authenticate takes nobody from a made token with its secret left out', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [id] = made.secret.split('.');

  expect(tokens.authenticate(`${String(id)}.`)).toBeNull();
});

test('#authenticate takes nobody from a made token with a part added', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.authenticate(`${made.secret}.extra`)).toBeNull();
});

test('#authenticate takes nobody from a made token with its dot left out', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.authenticate(made.secret.replace('.', ''))).toBeNull();
});

test('#authenticate takes nobody for a stored hash that is not a SHA-256 digest', async () => {
  const ctx = await setupTest();

  await writeTokenRecord(
    ctx.db,
    buildMockTokenRecord({ id: 'abcdefghijklmnop', secretHash: 'abcd' }),
    [],
  );

  const tokens = await ctx.load('root-secret');

  expect(tokens.authenticate('imp_abcdefghijklmnop.c2VjcmV0')).toBeNull();
});

test('#remove ends a token’s secret', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  await tokens.remove('ci');

  expect(tokens.authenticate(made.secret)).toBeNull();
});

test('#remove ends a token’s id, as a dashboard session names it', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  await tokens.remove('ci');

  expect(tokens.findById(tokenId)).toBeNull();
});

test('#remove reports the token’s id so what it opened ends', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  await tokens.remove('ci');

  expect(ctx.removed).toStrictEqual([tokenId]);
});

test('#remove refuses a name no token has', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.remove('ci')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'token ci not found',
  });
});

test('#create refuses a name a token has', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.create({ name: 'ci', scope: 'exec', imps: null })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'token ci already exists',
  });
});

test('#create refuses the name root', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.create({ name: 'root', scope: 'read', imps: null })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'token root already exists',
  });
});

test.each([
  ['Bearer abc', 'abc'],
  ['Basic abc', null],
  ['bearer abc', null],
  [null, null],
])('#readBearer reads %p as %p', (header, secret) => {
  expect(readBearer(header)).toBe(secret);
});

test('#addKey binds a key to a token and gives the key as the API shows it', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@desk`;

  await tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  const added = await tokens.addKey('dev', line);

  expect(added).toStrictEqual({
    fingerprint: formatKeyFingerprint(blob),
    type: 'ssh-ed25519',
    comment: 'me@desk',
  });
});

test('#list lists a token’s keys after a restart, made with it or added after', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret');

  const laptop = `${createEd25519Key().public} me@laptop`;
  const desk = `${createEd25519Key().public} me@desk`;

  await before.create({ name: 'dev', scope: 'exec', imps: ['dev-*'], sshKeys: [laptop] });
  await before.addKey('dev', desk);

  const laptopBlob = Buffer.from(laptop.split(' ')[1] ?? '', 'base64');
  const deskBlob = Buffer.from(desk.split(' ')[1] ?? '', 'base64');

  const restarted = await ctx.load('root-secret');

  expect(restarted.list()[0]?.sshKeys).toStrictEqual([
    {
      fingerprint: formatKeyFingerprint(laptopBlob),
      type: 'ssh-ed25519',
      comment: 'me@laptop',
    },
    {
      fingerprint: formatKeyFingerprint(deskBlob),
      type: 'ssh-ed25519',
      comment: 'me@desk',
    },
  ]);
});

test('#findSshKey logs a bound key in as its token, after a restart', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;

  const made = await before.create({
    name: 'dev',
    scope: 'exec',
    imps: ['dev-*'],
    sshKeys: [line],
  });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  const restarted = await ctx.load('root-secret');

  expect(restarted.findSshKey(blob)).toStrictEqual({
    key: { type: 'ssh-ed25519', blob, comment: 'me@laptop', verify: expect.toBeFunction() },
    keyId: expect.toBeString(),
    caller: {
      kind: 'ssh',
      name: 'dev',
      scope: 'exec',
      imps: ['dev-*'],
      grantable: [],
      tokenId,
      grantId: null,
      expiresAt: null,
      principal: `token:${tokenId}`,
      display: 'dev',
    },
  });
});

test('#findSshKey finds nothing for a key no token holds', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({
    name: 'dev',
    scope: 'exec',
    imps: null,
    sshKeys: [`${createEd25519Key().public} me@laptop`],
  });

  const [, other = ''] = createEd25519Key().public.split(' ');

  expect(tokens.findSshKey(Buffer.from(other, 'base64'))).toBeNull();
});

test('#load skips a stored key that no longer parses, and keeps its token', async () => {
  const ctx = await setupTest();

  const record = buildMockTokenRecord({ name: 'dev' });

  await writeTokenRecord(ctx.db, record, [
    buildMockTokenSshKeyRecord({ tokenId: record.id, publicKey: 'ssh-ed25519 !!!' }),
  ]);

  const tokens = await ctx.load('root-secret');

  expect(tokens.list()).toStrictEqual([
    {
      name: 'dev',
      scope: record.scope,
      imps: record.imps,
      grantable: [],
      sshKeys: [],
      createdAt: record.createdAt,
    },
  ]);
});

test('#addKey refuses a key bound to another token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  const fingerprint = formatKeyFingerprint(blob);

  await tokens.create({ name: 'a', scope: 'read', imps: null, sshKeys: [line] });
  await tokens.create({ name: 'b', scope: 'read', imps: null });

  expect(tokens.addKey('b', line)).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `key ${fingerprint} is bound to a token`,
  });
});

test('#create refuses the same key given twice', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;

  expect(
    tokens.create({ name: 'c', scope: 'read', imps: null, sshKeys: [line, line] }),
  ).rejects.toMatchObject({ code: 'CONFLICT', message: 'the same key is given twice' });
});

test('#create makes no token when one of its keys is refused', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;

  expect(
    tokens.create({ name: 'c', scope: 'read', imps: null, sshKeys: [line, line] }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });

  expect(tokens.list()).toStrictEqual([]);
});

test('#addKey refuses a key authorized_keys lists', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} in the file`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  ctx.fileKeys.add(blob.toString('base64'));

  await tokens.create({ name: 'b', scope: 'read', imps: null });

  expect(tokens.addKey('b', line)).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `key ${formatKeyFingerprint(blob)} is in authorized_keys, where it has every imp; delete that line, then bind it`,
  });
});

test('#addKey refuses a name no token has', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.addKey('nobody', `${createEd25519Key().public} me@laptop`)).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'token nobody not found',
  });
});

test.each([
  ['not a key', 'not an SSH public key: options are not supported; put the key type first'],
  [
    'restrict ssh-ed25519 AAAA',
    'not an SSH public key: options are not supported; put the key type first',
  ],
  ['ssh-dss AAAA', 'not an SSH public key: ssh-dss keys are not supported'],
])('#addKey refuses the line %p', async (line, message) => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.addKey('ci', line)).rejects.toMatchObject({ code: 'BAD_REQUEST', message });
});

test('#addKey refuses a key whose data does not parse', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'ci', scope: 'read', imps: null });

  expect(tokens.addKey('ci', 'ssh-ed25519 !!!')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.toStartWith('not an SSH public key: '),
  });
});

test('#addKey refuses a 17th key', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({
    name: 'ci',
    scope: 'read',
    imps: null,
    sshKeys: Array.from({ length: 16 }, () => createEd25519Key().public),
  });

  expect(tokens.addKey('ci', createEd25519Key().public)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'token ci holds 16 keys, the most it may',
  });
});

test('#removeKey refuses to unbind a key authorized_keys lists since it was bound', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  const fingerprint = formatKeyFingerprint(blob);

  await tokens.create({ name: 'a', scope: 'exec', imps: ['dev-*'], sshKeys: [line] });

  ctx.fileKeys.add(blob.toString('base64'));

  expect(tokens.removeKey('a', fingerprint)).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `key ${fingerprint} is in authorized_keys too, where it has every imp; delete that line, then unbind it`,
  });
});

test('#removeKey leaves a key authorized_keys lists bound to its token after the refusal', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  await tokens.create({ name: 'a', scope: 'exec', imps: ['dev-*'], sshKeys: [line] });

  ctx.fileKeys.add(blob.toString('base64'));

  const [attempt] = await Promise.allSettled([tokens.removeKey('a', formatKeyFingerprint(blob))]);

  expect(attempt?.status).toBe('rejected');
  expect(tokens.findSshKey(blob)?.caller.name).toBe('a');
});

test('#remove refuses a token while authorized_keys lists one of its keys, which stays bound', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  await tokens.create({ name: 'a', scope: 'exec', imps: ['dev-*'], sshKeys: [line] });

  ctx.fileKeys.add(blob.toString('base64'));

  expect(tokens.remove('a')).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `key ${formatKeyFingerprint(blob)} is in authorized_keys too, where it has every imp; delete that line, then unbind it`,
  });

  expect(tokens.findSshKey(blob)?.caller.name).toBe('a');
  expect(ctx.removed).toStrictEqual([]);
});

test('#remove takes a token whose key authorized_keys no longer lists', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  await tokens.create({ name: 'a', scope: 'exec', imps: ['dev-*'], sshKeys: [line] });

  ctx.fileKeys.add(blob.toString('base64'));

  const refused = await Promise.allSettled([tokens.remove('a')]);

  ctx.fileKeys.clear();

  await tokens.remove('a');

  expect(refused[0]?.status).toBe('rejected');
  expect(tokens.findSshKey(blob)).toBeNull();
});

test('#removeKey unbinds a key and reports its id', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  await tokens.create({ name: 'a', scope: 'exec', imps: null, sshKeys: [line] });

  const bound = tokens.findSshKey(blob);

  invariant(bound);

  await tokens.removeKey('a', formatKeyFingerprint(blob));

  expect(tokens.findSshKey(blob)).toBeNull();
  expect(ctx.removed).toStrictEqual([bound.keyId]);
});

test('#addKey binds a key again under a new id', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  await tokens.create({ name: 'a', scope: 'exec', imps: null, sshKeys: [line] });

  const first = tokens.findSshKey(blob);

  invariant(first);

  await tokens.removeKey('a', formatKeyFingerprint(blob));
  await tokens.addKey('a', line);

  const again = tokens.findSshKey(blob);

  invariant(again);

  expect(again.keyId).not.toBe(first.keyId);
});

test('#remove ends a token’s keys and reports the token’s id', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  const made = await tokens.create({ name: 'a', scope: 'exec', imps: null, sshKeys: [line] });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  await tokens.remove('a');

  expect(tokens.findSshKey(blob)).toBeNull();
  expect(ctx.removed).toStrictEqual([tokenId]);
});

test('#create binds a key a removed token held', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  await tokens.create({ name: 'a', scope: 'exec', imps: null, sshKeys: [line] });
  await tokens.remove('a');
  await tokens.create({ name: 'b', scope: 'read', imps: null, sshKeys: [line] });

  expect(tokens.findSshKey(blob)?.caller.name).toBe('b');
});

test('#removeKey refuses a fingerprint no key has', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'a', scope: 'read', imps: null });

  expect(tokens.removeKey('a', 'SHA256:nothing')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'ssh-key SHA256:nothing not found',
  });
});

test('#removeKey refuses a key bound to another token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;
  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  const fingerprint = formatKeyFingerprint(blob);

  await tokens.create({ name: 'a', scope: 'read', imps: null });
  await tokens.create({ name: 'b', scope: 'read', imps: null, sshKeys: [line] });

  expect(tokens.removeKey('a', fingerprint)).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: `ssh-key ${fingerprint} not found`,
  });
});

test('#removeKey refuses a name no token has', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.removeKey('nobody', 'SHA256:nothing')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'token nobody not found',
  });
});

// An ssh login checks its token once (ssh-gateway.ts checkLogin), so a
// change to scope or imps would have to end live connections, as delete does
test('#loadTokenStore offers no change to a token’s scope or imps in place', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(Object.keys(tokens)).toIncludeSameMembers([
    'list',
    'create',
    'updateGrantable',
    'remove',
    'addKey',
    'removeKey',
    'findSshKey',
    'authenticate',
    'findById',
  ]);
});

// the contract half of the same guard; it belongs beside @imp/api's
// contract, which this package does not own
test('#impContract offers no token procedure beyond the known ones', () => {
  expect(Object.keys(impContract.tokens).toSorted()).toStrictEqual([
    'addKey',
    'create',
    'delete',
    'list',
    'removeKey',
    'update',
    'whoami',
  ]);
});

test('#impContract lets a token update change only its grantable list', () => {
  expect(Object.keys(impContract.tokens.update['~orpc'].inputSchema?.shape ?? {})).toStrictEqual([
    'name',
    'grantable',
  ]);
});

test('#create binds a grantable list to each secret’s generation now', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });
  await createSecret(ctx.db, { name: 'npm', kind: 'github', rules: [], valueFile: 'npm' });

  const gh = await findSecret(ctx.db, 'gh');
  const npm = await findSecret(ctx.db, 'npm');

  const made = await tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  invariant(gh);
  invariant(npm);

  expect(tokens.authenticate(made.secret)?.grantable).toStrictEqual([
    { name: 'gh', generation: gh.generation },
    { name: 'npm', generation: npm.generation },
  ]);
});

test('#authenticate gives a made token’s grantable list, after a restart', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  const gh = await findSecret(ctx.db, 'gh');

  const made = await before.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const restarted = await ctx.load('root-secret');

  invariant(gh);

  expect(restarted.authenticate(made.secret)?.grantable).toStrictEqual([
    { name: 'gh', generation: gh.generation },
  ]);
});

test('#list shows a grantable list by name, after a restart', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  await before.create({ name: 'agent', scope: 'manage', imps: ['dev-*'], grantable: ['gh'] });

  const restarted = await ctx.load('root-secret');

  expect(restarted.list()[0]?.grantable).toStrictEqual(['gh']);
});

test('#findSshKey gives a key’s login its token’s grantable list, after a restart', async () => {
  const ctx = await setupTest();
  const before = await ctx.load('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  const gh = await findSecret(ctx.db, 'gh');

  await before.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    sshKeys: [line],
    grantable: ['gh'],
  });

  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');

  const restarted = await ctx.load('root-secret');

  invariant(gh);

  expect(restarted.findSshKey(blob)?.caller.grantable).toStrictEqual([
    { name: 'gh', generation: gh.generation },
  ]);
});

test('#create refuses a grantable list for a host-wide token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  expect(
    tokens.create({ name: 'a', scope: 'manage', imps: null, grantable: ['gh'] }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a token that may grant secrets needs scope manage and imp patterns',
  });
});

test('#create refuses a grantable list for a token below manage', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  expect(
    tokens.create({ name: 'b', scope: 'exec', imps: ['dev-*'], grantable: ['gh'] }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a token that may grant secrets needs scope manage and imp patterns',
  });
});

test('#create refuses a grantable list naming a secret that does not exist', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(
    tokens.create({ name: 'c', scope: 'manage', imps: ['dev-*'], grantable: ['nope'] }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'secret', name: 'nope' } });
});

test('#updateGrantable binds a new list to each secret’s generation now', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret', () => 1_800_000_000_000);

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });
  await createSecret(ctx.db, { name: 'npm', kind: 'github', rules: [], valueFile: 'npm' });

  await tokens.create({ name: 'agent', scope: 'manage', imps: ['dev-*'], grantable: ['gh'] });

  const updated = await tokens.updateGrantable('agent', ['npm']);

  expect(updated).toStrictEqual({
    token: {
      name: 'agent',
      scope: 'manage',
      imps: ['dev-*'],
      grantable: ['npm'],
      sshKeys: [],
      createdAt: new Date(1_800_000_000_000),
    },
    droppedGrants: 0,
  });
});

test('#updateGrantable gives the token’s next caller the new list', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'npm', kind: 'github', rules: [], valueFile: 'npm' });

  const npm = await findSecret(ctx.db, 'npm');
  const made = await tokens.create({ name: 'agent', scope: 'manage', imps: ['dev-*'] });

  await tokens.updateGrantable('agent', ['npm']);

  invariant(npm);

  expect(tokens.authenticate(made.secret)?.grantable).toStrictEqual([
    { name: 'npm', generation: npm.generation },
  ]);
});

test('#updateGrantable refuses a name no token has', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  expect(tokens.updateGrantable('nobody', [])).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'token nobody not found',
  });
});

test('#updateGrantable refuses a token removed from the database since it was loaded', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');
  const made = await tokens.create({ name: 'agent', scope: 'manage', imps: ['dev-*'] });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  await removeTokenRecord(ctx.db, tokenId);

  expect(tokens.updateGrantable('agent', [])).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'token agent not found',
  });
});

test('#updateGrantable refuses a secret that does not exist', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await tokens.create({ name: 'agent', scope: 'manage', imps: ['dev-*'] });

  expect(tokens.updateGrantable('agent', ['nope'])).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'nope' },
  });
});

test('#updateGrantable refuses a list for a host-wide token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.load('root-secret');

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  await tokens.create({ name: 'host', scope: 'manage', imps: null });

  expect(tokens.updateGrantable('host', ['gh'])).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a token that may grant secrets needs scope manage and imp patterns',
  });
});
