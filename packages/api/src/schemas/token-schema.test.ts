import { expect, test } from 'bun:test';
import {
  GrantableSchema,
  GrantableUpdateSchema,
  IdentitySchema,
  ImageRefPrefixSchema,
  ImpPatternSchema,
  ScopeSchema,
  SshKeySchema,
  SshPublicKeySchema,
  TokenSchema,
} from './token-schema';

test.each(['read', 'exec', 'manage'])('#ScopeSchema accepts the scope %s', (scope) => {
  expect(ScopeSchema.safeParse(scope).data).toBe(scope);
});

test('#ScopeSchema rejects a scope outside the list', () => {
  const result = ScopeSchema.safeParse('admin');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});

test.each(['dev', 'dev-*', '*', '*-test', `a${'b'.repeat(30)}`])(
  '#ImpPatternSchema accepts the pattern %s',
  (pattern) => {
    expect(ImpPatternSchema.safeParse(pattern).data).toBe(pattern);
  },
);

test.each(['', '2dev', '-dev', 'Dev', 'dev_*', 'dev?', `a${'b'.repeat(31)}`])(
  '#ImpPatternSchema rejects the pattern %p',
  (pattern) => {
    const result = ImpPatternSchema.safeParse(pattern);

    expect(result.error?.issues).toPartiallyContain({
      path: [],
      message: 'must be an imp name, with * for any run of characters, such as dev-*',
    });
  },
);

test('#GrantableSchema accepts distinct secret names', () => {
  expect(GrantableSchema.safeParse(['github-token', 'npm-token']).data).toStrictEqual([
    'github-token',
    'npm-token',
  ]);
});

test('#GrantableSchema rejects an empty list', () => {
  const result = GrantableSchema.safeParse([]);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test('#GrantableSchema rejects more than 32 names', () => {
  const result = GrantableSchema.safeParse(Array.from({ length: 33 }, (_, index) => `s${index}`));

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test('#GrantableSchema rejects a name that is not a secret name', () => {
  const result = GrantableSchema.safeParse(['github-token', 'NPM']);

  expect(result.error?.issues).toPartiallyContain({ path: [1], code: 'invalid_format' });
});

test('#GrantableSchema rejects a secret named twice', () => {
  const result = GrantableSchema.safeParse(['github-token', 'github-token']);

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message: 'must not name a secret twice',
  });
});

test('#GrantableUpdateSchema accepts an empty list', () => {
  expect(GrantableUpdateSchema.safeParse([]).data).toStrictEqual([]);
});

test('#GrantableUpdateSchema rejects more than 32 names', () => {
  const result = GrantableUpdateSchema.safeParse(
    Array.from({ length: 33 }, (_, index) => `s${index}`),
  );

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test('#GrantableUpdateSchema rejects a name that is not a secret name', () => {
  const result = GrantableUpdateSchema.safeParse(['github-token', 'NPM']);

  expect(result.error?.issues).toPartiallyContain({ path: [1], code: 'invalid_format' });
});

test('#GrantableUpdateSchema rejects a secret named twice', () => {
  const result = GrantableUpdateSchema.safeParse(['github-token', 'github-token']);

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message: 'must not name a secret twice',
  });
});

test.each([
  ['a registry host and a path start', 'ghcr.io/zgeoff/nixie-'],
  ['a whole repository', 'ghcr.io/zgeoff/nixie-sandbox'],
  ['a registry host with a port', 'registry.test:5000/team/'],
  ['localhost', 'localhost/app'],
])('#ImageRefPrefixSchema accepts %s', (_label, source) => {
  expect(ImageRefPrefixSchema.safeParse(source).data).toBe(source);
});

test.each([
  ['a bare path, which docker reads as Docker Hub', 'zgeoff/nixie-'],
  ['a registry host alone', 'ghcr.io/'],
  ['a tag', 'ghcr.io/zgeoff/nixie:1'],
  ['a digest', 'ghcr.io/zgeoff/nixie@sha256:'],
  ['an upper-case host', 'GHCR.io/zgeoff/nixie-'],
])('#ImageRefPrefixSchema rejects %s', (_label, source) => {
  const result = ImageRefPrefixSchema.safeParse(source);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
});

test('#ImageRefPrefixSchema rejects a source over 200 characters', () => {
  const result = ImageRefPrefixSchema.safeParse(`ghcr.io/${'a'.repeat(200)}`);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test('#SshPublicKeySchema trims the whitespace around a key line', () => {
  expect(SshPublicKeySchema.safeParse('  ssh-ed25519 AAAAC3Nza dev@laptop\n').data).toBe(
    'ssh-ed25519 AAAAC3Nza dev@laptop',
  );
});

test('#SshPublicKeySchema rejects a key line of only whitespace', () => {
  const result = SshPublicKeySchema.safeParse('  \n');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test('#SshPublicKeySchema rejects a key line over 16384 characters', () => {
  const result = SshPublicKeySchema.safeParse(`ssh-rsa ${'A'.repeat(16_377)}`);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test('#SshKeySchema accepts a bound key', () => {
  const payload = {
    fingerprint: 'SHA256:abc',
    type: 'ssh-ed25519',
    comment: 'dev@laptop',
  } as const;

  const result = SshKeySchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TokenSchema accepts a token limited to some imps', () => {
  const payload = {
    name: 'ci',
    scope: 'exec',
    imps: ['ci-*'],
    sshKeys: [{ fingerprint: 'SHA256:abc', type: 'ssh-ed25519', comment: 'ci@runner' }],
    grantable: ['github-token'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  const result = TokenSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TokenSchema defaults grantable and the image ref prefix to none for an older impd', () => {
  const result = TokenSchema.safeParse({
    name: 'ci',
    scope: 'exec',
    imps: null,
    sshKeys: [],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.data).toStrictEqual({
    name: 'ci',
    scope: 'exec',
    imps: null,
    sshKeys: [],
    grantable: [],
    imageRefPrefix: null,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });
});

test('#TokenSchema rejects a name that is not a name', () => {
  const result = TokenSchema.safeParse({
    name: 'CI',
    scope: 'exec',
    imps: ['ci-*'],
    sshKeys: [],
    grantable: ['github-token'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#TokenSchema rejects a scope outside the list', () => {
  const result = TokenSchema.safeParse({
    name: 'ci',
    scope: 'admin',
    imps: ['ci-*'],
    sshKeys: [],
    grantable: ['github-token'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['scope'], code: 'invalid_value' });
});

test('#TokenSchema rejects an imp pattern that is not a pattern', () => {
  const result = TokenSchema.safeParse({
    name: 'ci',
    scope: 'exec',
    imps: ['CI-*'],
    sshKeys: [],
    grantable: ['github-token'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['imps', 0], code: 'invalid_format' });
});

test('#TokenSchema rejects a grantable name that is not a secret name', () => {
  const result = TokenSchema.safeParse({
    name: 'ci',
    scope: 'exec',
    imps: ['ci-*'],
    sshKeys: [],
    grantable: ['GitHub'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['grantable', 0],
    code: 'invalid_format',
  });
});

test('#TokenSchema rejects a creation time that is not a date', () => {
  const result = TokenSchema.safeParse({
    name: 'ci',
    scope: 'exec',
    imps: ['ci-*'],
    sshKeys: [],
    grantable: ['github-token'],
    createdAt: '2026-01-02T03:04:05.000Z',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['createdAt'], code: 'invalid_type' });
});

test('#IdentitySchema accepts a tailnet identity', () => {
  const payload = {
    kind: 'tailnet',
    name: 'dev@example.com',
    scope: 'manage',
    imps: null,
    grantable: ['github-token'],
    imageRefPrefix: null,
  } as const;

  const result = IdentitySchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#IdentitySchema defaults grantable and the image ref prefix to none', () => {
  const result = IdentitySchema.safeParse({
    kind: 'token',
    name: 'ci',
    scope: 'read',
    imps: ['ci-*'],
  });

  expect(result.data).toStrictEqual({
    kind: 'token',
    name: 'ci',
    scope: 'read',
    imps: ['ci-*'],
    grantable: [],
    imageRefPrefix: null,
  });
});

test('#IdentitySchema rejects a kind outside the actors', () => {
  const result = IdentitySchema.safeParse({
    kind: 'robot',
    name: 'ci',
    scope: 'read',
    imps: ['ci-*'],
    grantable: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_value' });
});

test('#IdentitySchema rejects a scope outside the list', () => {
  const result = IdentitySchema.safeParse({
    kind: 'token',
    name: 'ci',
    scope: 'admin',
    imps: ['ci-*'],
    grantable: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['scope'], code: 'invalid_value' });
});

test('#IdentitySchema rejects an imp pattern that is not a pattern', () => {
  const result = IdentitySchema.safeParse({
    kind: 'token',
    name: 'ci',
    scope: 'read',
    imps: ['CI-*'],
    grantable: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['imps', 0], code: 'invalid_format' });
});

test('#IdentitySchema rejects a grantable name that is not a secret name', () => {
  const result = IdentitySchema.safeParse({
    kind: 'token',
    name: 'ci',
    scope: 'read',
    imps: ['ci-*'],
    grantable: ['GitHub'],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['grantable', 0],
    code: 'invalid_format',
  });
});
