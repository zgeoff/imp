import { expect, test } from 'bun:test';
import {
  ApprovalCodeSchema,
  GrantPatternSchema,
  OAuthApprovalSchema,
  OAuthClientSchema,
  OAuthGrantSchema,
  RedirectUriSchema,
  RedirectUrisSchema,
} from './oauth-schema';

test.each([
  'https://claude.ai/api/mcp/auth_callback',
  'http://127.0.0.1:3000/cb',
  'http://[::1]/cb',
  'http://localhost/cb',
])('#RedirectUriSchema accepts the URI %s', (input) => {
  expect(RedirectUriSchema.safeParse(input).data).toBe(input);
});

test.each([
  'not a url',
  'http://example.com/cb',
  'https://example.com/cb#frag',
  'ftp://localhost/cb',
])('#RedirectUriSchema rejects the URI %s', (input) => {
  const result = RedirectUriSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: [],
      message: 'must be an https URL, or http on a loopback host, with no fragment',
    }),
  );
});

test('#RedirectUriSchema rejects a URI longer than 2048 characters', () => {
  const result = RedirectUriSchema.safeParse(`https://example.com/${'a'.repeat(2030)}`);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: [], code: 'too_big' }),
  );
});

test('#RedirectUrisSchema accepts distinct URIs', () => {
  expect(
    RedirectUrisSchema.safeParse(['https://claude.ai/cb', 'http://localhost/cb']).data,
  ).toStrictEqual(['https://claude.ai/cb', 'http://localhost/cb']);
});

test('#RedirectUrisSchema rejects no URIs', () => {
  const result = RedirectUrisSchema.safeParse([]);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#RedirectUrisSchema rejects more than 8 URIs', () => {
  const result = RedirectUrisSchema.safeParse([
    'https://example.com/0',
    'https://example.com/1',
    'https://example.com/2',
    'https://example.com/3',
    'https://example.com/4',
    'https://example.com/5',
    'https://example.com/6',
    'https://example.com/7',
    'https://example.com/8',
  ]);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#RedirectUrisSchema rejects a URI named twice', () => {
  const result = RedirectUrisSchema.safeParse(['https://claude.ai/cb', 'https://claude.ai/cb']);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: [], message: 'must not name a redirect URI twice' }),
  );
});

test('#RedirectUrisSchema rejects a URI that is not allowed', () => {
  const result = RedirectUrisSchema.safeParse(['https://claude.ai/cb', 'http://example.com/cb']);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: [1],
      message: 'must be an https URL, or http on a loopback host, with no fragment',
    }),
  );
});

test.each(['*', 'dev', 'dev-*', 'a*'])('#GrantPatternSchema accepts the pattern %s', (input) => {
  expect(GrantPatternSchema.safeParse(input).data).toBe(input);
});

test.each(['', 'Dev', '*dev', 'dev*x', '2dev'])(
  '#GrantPatternSchema rejects the pattern %s',
  (input) => {
    const result = GrantPatternSchema.safeParse(input);

    expect(result.error?.issues).toPartiallyContain(
      expect.objectContaining({
        path: [],
        message: 'must be an imp name, or a name prefix and a trailing *, such as dev-*',
      }),
    );
  },
);

test.each([
  ['ABCD-EFGH', 'ABCDEFGH'],
  [' abcd-efgh ', 'ABCDEFGH'],
  ['23456789', '23456789'],
])('#ApprovalCodeSchema reads the code %p as %p', (input, expected) => {
  expect(ApprovalCodeSchema.safeParse(input).data).toBe(expected);
});

test.each(['ABCD-EFG', 'ABCD-EFGHI', 'ABCD-EFGI', 'ABCD-EFG0', 'ABCD-EFG1'])(
  '#ApprovalCodeSchema rejects the code %s',
  (input) => {
    const result = ApprovalCodeSchema.safeParse(input);

    expect(result.error?.issues).toPartiallyContain(
      expect.objectContaining({
        path: [],
        message: 'must be the 8-symbol code the sign-in page shows',
      }),
    );
  },
);

test('#OAuthClientSchema accepts a client', () => {
  const payload = {
    name: 'claude',
    clientId: 'c-123',
    redirectUris: ['https://claude.ai/cb'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  expect(OAuthClientSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#OAuthClientSchema rejects a name that is not a valid name', () => {
  const result = OAuthClientSchema.safeParse({
    name: 'Claude',
    clientId: 'c-123',
    redirectUris: ['https://claude.ai/cb'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['name'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#OAuthGrantSchema accepts a grant limited to some imps', () => {
  const payload = {
    id: 'g-1',
    client: 'claude',
    token: 'laptop',
    scope: 'exec',
    imps: ['dev-*'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUsedAt: null,
  } as const;

  expect(OAuthGrantSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#OAuthGrantSchema accepts a grant over every imp', () => {
  const payload = {
    id: 'g-1',
    client: 'claude',
    token: 'laptop',
    scope: 'exec',
    imps: null,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUsedAt: new Date('2026-01-02T04:05:06.000Z'),
  } as const;

  expect(OAuthGrantSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#OAuthGrantSchema rejects a client that is not a valid name', () => {
  const result = OAuthGrantSchema.safeParse({
    id: 'g-1',
    client: 'Claude',
    token: 'laptop',
    scope: 'exec',
    imps: ['dev-*'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUsedAt: null,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['client'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#OAuthGrantSchema rejects a token that is not a valid name', () => {
  const result = OAuthGrantSchema.safeParse({
    id: 'g-1',
    client: 'claude',
    token: 'Laptop',
    scope: 'exec',
    imps: ['dev-*'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUsedAt: null,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['token'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#OAuthGrantSchema rejects a scope outside the scope list', () => {
  const result = OAuthGrantSchema.safeParse({
    id: 'g-1',
    client: 'claude',
    token: 'laptop',
    scope: 'admin',
    imps: ['dev-*'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUsedAt: null,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['scope'] }));
});

test('#OAuthGrantSchema rejects an imp pattern that is not a pattern', () => {
  const result = OAuthGrantSchema.safeParse({
    id: 'g-1',
    client: 'claude',
    token: 'laptop',
    scope: 'exec',
    imps: ['*dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUsedAt: null,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['imps', 0],
      message: 'must be an imp name, or a name prefix and a trailing *, such as dev-*',
    }),
  );
});

test('#OAuthApprovalSchema accepts an approval', () => {
  const payload = {
    client: 'claude',
    redirectUri: 'https://claude.ai/cb',
    requestedScope: 'manage',
    requestedAt: new Date('2026-01-02T03:04:05.000Z'),
    expiresAt: new Date('2026-01-02T04:05:06.000Z'),
  } as const;

  expect(OAuthApprovalSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#OAuthApprovalSchema rejects a client that is not a valid name', () => {
  const result = OAuthApprovalSchema.safeParse({
    client: 'Claude',
    redirectUri: 'https://claude.ai/cb',
    requestedScope: 'manage',
    requestedAt: new Date('2026-01-02T03:04:05.000Z'),
    expiresAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['client'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#OAuthApprovalSchema rejects a scope outside the scope list', () => {
  const result = OAuthApprovalSchema.safeParse({
    client: 'claude',
    redirectUri: 'https://claude.ai/cb',
    requestedScope: 'admin',
    requestedAt: new Date('2026-01-02T03:04:05.000Z'),
    expiresAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['requestedScope'] }),
  );
});
