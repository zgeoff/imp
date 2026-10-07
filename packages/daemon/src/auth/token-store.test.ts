import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { utils } from 'ssh2';
import { createSecret, findSecret } from '../db/secrets';
import { readRejection } from '../read-rejection';
import { formatKeyFingerprint } from '../ssh/authorized-keys';
import { createEd25519Key } from '../ssh/host-key';
import { createTestDatabase } from '../test-utils/create-test-database';
import { ROOT_TOKEN_ID, loadTokenStore, readBearer } from './token-store';

const NOW = 1_800_000_000_000;

async function setupTest() {
  const database = await createTestDatabase();

  const removed: string[] = [];

  // the blobs authorized_keys lists, in base64
  const fileKeys = new Set<string>();

  const load = () =>
    loadTokenStore({
      db: database.db,
      rootToken: 'root-secret',
      now: () => NOW,
      onRemove: (id) => {
        removed.push(id);
      },
      isFileKey: (blob) => fileKeys.has(blob.toString('base64')),
    });

  return { ...database, removed, fileKeys, load, tokens: await load() };
}

test('the root token stays valid as root, with every scope', async () => {
  await using ctx = await setupTest();

  expect(ctx.tokens.authenticate('root-secret')).toMatchObject({
    name: 'root',
    scope: 'manage',
    imps: null,
    tokenId: ROOT_TOKEN_ID,
  });

  expect(ctx.tokens.findById(ROOT_TOKEN_ID)?.name).toBe('root');
  expect(ctx.tokens.list()).toEqual([]);
});

test('a made token is stored hashed, survives a restart and authenticates', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const secretPart = made.secret.split('.')[1] ?? '';

  const rows = await ctx.db.selectFrom('tokens').selectAll().execute();

  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(secretPart);
  expect(rows[0]?.secret_hash).toMatch(/^[0-9a-f]{64}$/);

  const restarted = await ctx.load();

  expect(restarted.authenticate(made.secret)).toMatchObject({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });

  expect(restarted.list()).toEqual([
    {
      name: 'ci',
      scope: 'exec',
      imps: ['dev-*'],
      sshKeys: [],
      grantable: [],
      createdAt: new Date(NOW),
    },
  ]);
});

test('a wrong secret, a wrong id or a bent format authenticates nothing', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [id = '', secret = ''] = made.secret.slice('imp_'.length).split('.');
  const flipped = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;

  for (const given of [
    `imp_${id}.${flipped}`,
    `imp_${id}.`,
    `imp_${id}.${secret}.extra`,
    `imp_nosuchid0000000.${secret}`,
    `imp_${id}${secret}`,
    '',
    'root-secret ',
    'root-secre',
  ]) {
    expect(ctx.tokens.authenticate(given)).toBeNull();
  }
});

test('a removed token authenticates nothing and its id is reported', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'read', imps: null });

  const tokenId = ctx.tokens.authenticate(made.secret)?.tokenId ?? '';

  await ctx.tokens.remove('ci');

  expect(ctx.tokens.authenticate(made.secret)).toBeNull();
  expect(ctx.tokens.findById(tokenId)).toBeNull();
  expect(ctx.removed).toEqual([tokenId]);

  const missing = await ctx.tokens.remove('ci').catch((error: unknown) => error);

  expect(missing).toMatchObject({ code: 'NOT_FOUND' });
});

test('a bearer header gives its secret', () => {
  expect(readBearer('Bearer abc')).toBe('abc');
  expect(readBearer('Basic abc')).toBeNull();
  expect(readBearer(null)).toBeNull();
});

// a public key line with a comment, its fingerprint and its blob
function createPublicKey(comment: string) {
  const line = `${createEd25519Key().public} ${comment}`;
  const parsed = utils.parseKey(line);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const blob = parsed.getPublicSSH();

  return { line, blob, fingerprint: formatKeyFingerprint(blob) };
}

test('a key bound to a token logs in as that token, after a restart too', async () => {
  await using ctx = await setupTest();

  const laptop = createPublicKey('me@laptop');
  const desk = createPublicKey('me@desk');

  await ctx.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'], sshKeys: [laptop.line] });

  const added = await ctx.tokens.addKey('dev', desk.line);

  expect(added).toEqual({ fingerprint: desk.fingerprint, type: 'ssh-ed25519', comment: 'me@desk' });

  const restarted = await ctx.load();

  expect(restarted.list()[0]?.sshKeys).toEqual([
    { fingerprint: laptop.fingerprint, type: 'ssh-ed25519', comment: 'me@laptop' },
    { fingerprint: desk.fingerprint, type: 'ssh-ed25519', comment: 'me@desk' },
  ]);

  const bound = restarted.findSshKey(laptop.blob);

  expect(bound?.caller).toMatchObject({ kind: 'ssh', name: 'dev', scope: 'exec', imps: ['dev-*'] });
  expect(bound?.caller.tokenId).toBe(ctx.tokens.findSshKey(laptop.blob)?.caller.tokenId ?? '');
  expect(restarted.findSshKey(createPublicKey('other').blob)).toBeNull();
});

test('a key binds once: not twice, not to two tokens, and not while authorized_keys lists it', async () => {
  await using ctx = await setupTest();

  const key = createPublicKey('me@laptop');
  const listed = createPublicKey('in the file');

  ctx.fileKeys.add(listed.blob.toString('base64'));

  await ctx.tokens.create({ name: 'a', scope: 'read', imps: null, sshKeys: [key.line] });
  await ctx.tokens.create({ name: 'b', scope: 'read', imps: null });

  const [again, twice, inFile, unknown] = await Promise.all([
    readRejection(ctx.tokens.addKey('b', key.line)),
    readRejection(
      ctx.tokens.create({
        name: 'c',
        scope: 'read',
        imps: null,
        sshKeys: [listed.line, listed.line],
      }),
    ),
    readRejection(ctx.tokens.addKey('b', listed.line)),
    readRejection(ctx.tokens.addKey('nobody', key.line)),
  ]);

  expect(again).toMatchObject({ code: 'CONFLICT' });
  expect(twice).toMatchObject({ code: 'CONFLICT' });
  expect(inFile).toMatchObject({ code: 'CONFLICT' });
  expect(String(inFile)).toContain('delete that line, then bind it');
  expect(unknown).toMatchObject({ code: 'NOT_FOUND' });
  expect(ctx.tokens.list().map((token) => token.name)).toEqual(['a', 'b']);
});

test('a bound key that authorized_keys lists later stays bound until its line goes', async () => {
  await using ctx = await setupTest();

  const key = createPublicKey('me@laptop');

  await ctx.tokens.create({ name: 'a', scope: 'exec', imps: ['dev-*'], sshKeys: [key.line] });

  ctx.fileKeys.add(key.blob.toString('base64'));

  const [unbind, remove] = await Promise.all([
    readRejection(ctx.tokens.removeKey('a', key.fingerprint)),
    readRejection(ctx.tokens.remove('a')),
  ]);

  expect(unbind).toMatchObject({ code: 'CONFLICT' });
  expect(remove).toMatchObject({ code: 'CONFLICT' });
  expect(String(unbind)).toContain('delete that line, then unbind it');
  expect(ctx.tokens.findSshKey(key.blob)?.caller.name).toBe('a');
  expect(ctx.removed).toEqual([]);

  ctx.fileKeys.clear();

  await ctx.tokens.remove('a');

  expect(ctx.tokens.findSshKey(key.blob)).toBeNull();
});

test('a line that is not a plain public key binds nothing', async () => {
  await using ctx = await setupTest();

  await ctx.tokens.create({ name: 'ci', scope: 'read', imps: null });

  const key = createPublicKey('x');

  const failures = await Promise.all(
    ['not a key', `restrict ${key.line}`, 'ssh-dss AAAA', 'ssh-ed25519 !!!'].map((line) =>
      readRejection(ctx.tokens.addKey('ci', line)),
    ),
  );

  for (const failure of failures) {
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  }
});

test('a token holds at most 16 keys', async () => {
  await using ctx = await setupTest();

  const lines = Array.from({ length: 16 }, (_, index) => createPublicKey(String(index)).line);

  await ctx.tokens.create({ name: 'ci', scope: 'read', imps: null, sshKeys: lines });

  const failure = await readRejection(ctx.tokens.addKey('ci', createPublicKey('17').line));

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
});

test('removing a key or its token reports the ids, and the key binds again with a new id', async () => {
  await using ctx = await setupTest();

  const key = createPublicKey('me@laptop');

  await ctx.tokens.create({ name: 'a', scope: 'exec', imps: null, sshKeys: [key.line] });

  const first = ctx.tokens.findSshKey(key.blob)?.keyId ?? '';

  await ctx.tokens.removeKey('a', key.fingerprint);

  expect(ctx.tokens.findSshKey(key.blob)).toBeNull();
  expect(ctx.removed).toEqual([first]);

  await ctx.tokens.addKey('a', key.line);

  const second = ctx.tokens.findSshKey(key.blob)?.keyId;
  const tokenId = ctx.tokens.findSshKey(key.blob)?.caller.tokenId ?? '';

  expect(second).not.toBe(first);

  await ctx.tokens.remove('a');

  expect(ctx.tokens.findSshKey(key.blob)).toBeNull();
  expect(ctx.removed).toEqual([first, tokenId]);

  // the key is free for another token
  await ctx.tokens.create({ name: 'b', scope: 'read', imps: null, sshKeys: [key.line] });

  const missing = await readRejection(ctx.tokens.removeKey('a', key.fingerprint));

  expect(missing).toMatchObject({ code: 'NOT_FOUND' });
});

// An ssh login checks its token once (ssh-gateway.ts checkLogin), so a
// change to scope or imps must end live connections, as delete does.
// tokens.update sets only the list, which a grant reads in its transaction.
test('no token procedure changes a token’s scope or imps in place', () => {
  expect(Object.keys(impContract.tokens).toSorted()).toEqual([
    'addKey',
    'create',
    'delete',
    'list',
    'removeKey',
    'update',
    'whoami',
  ]);

  expect(Object.keys(impContract.tokens.update['~orpc'].inputSchema?.shape ?? {})).toEqual([
    'name',
    'grantable',
  ]);
});

test('a grantable list keeps each secret’s generation, through a restart and its ssh keys', async () => {
  await using ctx = await setupTest();

  const laptop = createPublicKey('me@laptop');

  for (const name of ['gh', 'npm']) {
    await createSecret(ctx.db, { name, kind: 'github', rules: [], valueFile: name });
  }

  const secrets = await Promise.all(['gh', 'npm'].map((name) => findSecret(ctx.db, name)));

  const granted = secrets.map((secret) => ({
    name: secret?.name ?? '',
    generation: secret?.generation ?? '',
  }));

  const made = await ctx.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    sshKeys: [laptop.line],
    grantable: ['gh', 'npm'],
  });

  expect(made.token.grantable).toEqual(['gh', 'npm']);

  const restarted = await ctx.load();

  expect(restarted.authenticate(made.secret)?.grantable).toEqual(granted);

  expect(restarted.findSshKey(laptop.blob)?.caller).toMatchObject({
    kind: 'ssh',
    grantable: granted,
  });

  expect(restarted.list()[0]?.grantable).toEqual(['gh', 'npm']);

  // a host-wide token, or one below manage, may not take a list
  const refused = await Promise.all([
    readRejection(ctx.tokens.create({ name: 'a', scope: 'manage', imps: null, grantable: ['gh'] })),
    readRejection(
      ctx.tokens.create({ name: 'b', scope: 'exec', imps: ['dev-*'], grantable: ['gh'] }),
    ),
    readRejection(
      ctx.tokens.create({ name: 'c', scope: 'manage', imps: ['dev-*'], grantable: ['nope'] }),
    ),
  ]);

  expect(refused).toMatchObject([
    { code: 'BAD_REQUEST' },
    { code: 'BAD_REQUEST' },
    { code: 'NOT_FOUND', data: { kind: 'secret', name: 'nope' } },
  ]);
});
