import { expect, test } from 'bun:test';
import {
  AuditEntrySchema,
  BrokerHostSchema,
  BrokerRuleSchema,
  OAuthConfigSchema,
  SecretAddedSchema,
  SecretKindSchema,
  SecretNameSchema,
  SecretSchema,
  SecretValueSchema,
} from './secret-schema';

test.each([
  ['http://172.17.0.1:18081', 'http://172.17.0.1:18081'],
  ['https://x.example.com', 'https://x.example.com'],
  ['https://x.example.com/', 'https://x.example.com'],
])('#BrokerRuleSchema keeps the upstream %s as the origin %s', (upstream, origin) => {
  const result = BrokerRuleSchema.safeParse({
    host: 'svc.imp.internal',
    header: 'authorization',
    scheme: 'bearer',
    upstream,
  });

  expect(result.data).toStrictEqual({
    host: 'svc.imp.internal',
    header: 'authorization',
    scheme: 'bearer',
    upstream: origin,
  });
});

test.each([
  ['ftp://x.example.com', 'must be an http or https URL'],
  ['x.example.com', 'must be an http or https URL'],
  ['https://user:pass@x.example.com', 'must not hold a user name or password'],
  ['https://user@x.example.com', 'must not hold a user name or password'],
  ['https://x.example.com?a=1', 'must not have a query or a fragment'],
  ['https://x.example.com/?', 'must not have a query or a fragment'],
  ['https://x.example.com#top', 'must not have a query or a fragment'],
  ['https://x.example.com/api', 'must be an origin with no path'],
])('#BrokerRuleSchema rejects the upstream %s: %s', (upstream, message) => {
  const result = BrokerRuleSchema.safeParse({
    host: 'svc.imp.internal',
    header: 'authorization',
    scheme: 'bearer',
    upstream,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['upstream'], message });
});

test('#BrokerRuleSchema rejects an upstream longer than 2048 characters', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'svc.imp.internal',
    header: 'authorization',
    scheme: 'bearer',
    upstream: `https://${'a'.repeat(2048)}.example.com`,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['upstream'], code: 'too_big' });
});

test('#BrokerRuleSchema accepts a rule without an upstream', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'bearer',
  });

  expect(result.data).toStrictEqual({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'bearer',
  });
});

test('#BrokerRuleSchema accepts a basic rule with a user', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'basic',
    user: 'x-access-token',
  });

  expect(result.data).toStrictEqual({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'basic',
    user: 'x-access-token',
  });
});

test('#BrokerRuleSchema rejects a rule whose host is an IP address', () => {
  const result = BrokerRuleSchema.safeParse({
    host: '10.0.0.1',
    header: 'authorization',
    scheme: 'bearer',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['host'],
    message: 'must be a lowercase hostname such as api.example.com',
  });
});

test('#BrokerRuleSchema rejects a rule whose header is not lowercase', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'Authorization',
    scheme: 'bearer',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['header'],
    message: 'must be a lowercase header name such as authorization',
  });
});

test('#BrokerRuleSchema rejects a rule with an unknown scheme', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'digest',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['scheme'], code: 'invalid_value' });
});

test('#BrokerRuleSchema rejects a rule whose user holds a colon', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'basic',
    user: 'user:pass',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['user'],
    message: 'must be printable ASCII without a colon',
  });
});

test('#SecretNameSchema accepts a secret name that is a DNS label', () => {
  expect(SecretNameSchema.safeParse('gh-token').data).toBe('gh-token');
});

test('#SecretNameSchema rejects a secret name that could be a path', () => {
  const result = SecretNameSchema.safeParse('../token');

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test('#SecretValueSchema accepts a printable secret value', () => {
  expect(SecretValueSchema.safeParse('ghp_abc123').data).toBe('ghp_abc123');
});

test('#SecretValueSchema rejects a secret value with a line break', () => {
  const result = SecretValueSchema.safeParse('ghp_abc\r\nX-Other: 1');

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message: 'must be printable ASCII without spaces',
  });
});

test('#SecretValueSchema rejects an empty secret value', () => {
  const result = SecretValueSchema.safeParse('');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test('#OAuthConfigSchema defaults an oauth config to a form token request', () => {
  const result = OAuthConfigSchema.safeParse({
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client-1',
  });

  expect(result.data).toStrictEqual({
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client-1',
    tokenFormat: 'form',
  });
});

test('#OAuthConfigSchema rejects an oauth token URL over plain http', () => {
  const result = OAuthConfigSchema.safeParse({
    tokenUrl: 'http://auth.example.com/token',
    clientId: 'client-1',
    tokenFormat: 'json',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['tokenUrl'], code: 'invalid_format' });
});

test('#OAuthConfigSchema rejects an oauth client id with a space', () => {
  const result = OAuthConfigSchema.safeParse({
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client 1',
    tokenFormat: 'json',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['clientId'],
    message: 'must be printable ASCII without spaces',
  });
});

test('#OAuthConfigSchema rejects an unknown oauth token format', () => {
  const result = OAuthConfigSchema.safeParse({
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client-1',
    tokenFormat: 'xml',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['tokenFormat'], code: 'invalid_value' });
});

test.each(['api.example.com', 'svc.imp.internal', 'a1.b-2.example'])(
  '#BrokerHostSchema accepts the host %s',
  (host) => {
    expect(BrokerHostSchema.safeParse(host).data).toBe(host);
  },
);

test.each(['example', 'API.example.com', '10.0.0.1', '-x.example.com', 'a.example.com.'])(
  '#BrokerHostSchema rejects the host %s',
  (host) => {
    const result = BrokerHostSchema.safeParse(host);

    expect(result.error?.issues).toPartiallyContain({
      path: [],
      message: 'must be a lowercase hostname such as api.example.com',
    });
  },
);

test('#BrokerHostSchema rejects a host longer than 253 characters', () => {
  const result = BrokerHostSchema.safeParse(`${'a'.repeat(250)}.com`);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test.each(['github', 'anthropic', 'npm', 'custom', 'oauth'])(
  '#SecretKindSchema accepts the kind %s',
  (kind) => {
    expect(SecretKindSchema.safeParse(kind).data).toBe(kind);
  },
);

test('#SecretKindSchema rejects an unknown kind', () => {
  const result = SecretKindSchema.safeParse('aws');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});

test('#SecretSchema accepts a secret with its rules and grants', () => {
  const payload = {
    name: 'github-token',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  } as const;

  const result = SecretSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SecretSchema accepts an oauth secret with its state', () => {
  const payload = {
    name: 'claude',
    kind: 'oauth',
    rules: [{ host: 'api.anthropic.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    oauth: {
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'imp-client',
      tokenFormat: 'json',
      status: 'ready',
      expiresAt: new Date('2026-01-02T04:04:05.000Z'),
      refreshedAt: new Date('2026-01-02T03:04:05.000Z'),
      error: null,
      idClaims: { sub: 'user-1' },
    },
  } as const;

  const result = SecretSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SecretSchema rejects a name that is not a secret name', () => {
  const result = SecretSchema.safeParse({
    name: 'GitHub',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['name'], code: 'invalid_format' });
});

test('#SecretSchema rejects an unknown kind', () => {
  const result = SecretSchema.safeParse({
    name: 'github-token',
    kind: 'aws',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_value' });
});

test('#SecretSchema rejects a rule whose host is not a hostname', () => {
  const result = SecretSchema.safeParse({
    name: 'github-token',
    kind: 'github',
    rules: [{ host: '10.0.0.1', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['rules', 0, 'host'],
    code: 'invalid_format',
  });
});

test('#SecretSchema rejects a grant to an imp name that is not a name', () => {
  const result = SecretSchema.safeParse({
    name: 'github-token',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['Dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['imps', 0], code: 'invalid_format' });
});

test('#SecretSchema rejects an oauth state of an unknown status', () => {
  const result = SecretSchema.safeParse({
    name: 'claude',
    kind: 'oauth',
    rules: [{ host: 'api.anthropic.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    oauth: {
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'imp-client',
      tokenFormat: 'json',
      status: 'expired',
      expiresAt: null,
      refreshedAt: null,
      error: null,
      idClaims: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['oauth', 'status'],
    code: 'invalid_value',
  });
});

test('#SecretAddedSchema defaults the dropped grants to none', () => {
  const result = SecretAddedSchema.safeParse({
    name: 'github-token',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });

  expect(result.data).toStrictEqual({
    name: 'github-token',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    droppedGrants: 0,
  });
});

test('#SecretAddedSchema accepts the grants a rebind dropped', () => {
  const payload = {
    name: 'github-token',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    droppedGrants: 2,
  } as const;

  const result = SecretAddedSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test.each([
  [-1, 'too_small'],
  [1.5, 'invalid_type'],
])('#SecretAddedSchema rejects %p dropped grants with %s', (droppedGrants, code) => {
  const result = SecretAddedSchema.safeParse({
    name: 'github-token',
    kind: 'github',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    imps: ['dev'],
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    droppedGrants,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['droppedGrants'], code });
});

test('#AuditEntrySchema accepts a request the broker sent', () => {
  const payload = {
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    secret: 'github-token',
    method: 'GET',
    host: 'api.github.com',
    path: '/user',
    status: 200,
    requestBytes: 0,
    responseBytes: 1024,
    durationMs: 120,
  } as const;

  const result = AuditEntrySchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#AuditEntrySchema rejects an imp name that is not a name', () => {
  const result = AuditEntrySchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'Dev',
    secret: 'github-token',
    method: 'GET',
    host: 'api.github.com',
    path: '/user',
    status: 200,
    requestBytes: 0,
    responseBytes: 1024,
    durationMs: 120,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['imp'], code: 'invalid_format' });
});

test('#AuditEntrySchema rejects a secret name that is not a secret name', () => {
  const result = AuditEntrySchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    secret: 'GitHub',
    method: 'GET',
    host: 'api.github.com',
    path: '/user',
    status: 200,
    requestBytes: 0,
    responseBytes: 1024,
    durationMs: 120,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['secret'], code: 'invalid_format' });
});

test('#AuditEntrySchema rejects a host that is not a hostname', () => {
  const result = AuditEntrySchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    secret: 'github-token',
    method: 'GET',
    host: '10.0.0.1',
    path: '/user',
    status: 200,
    requestBytes: 0,
    responseBytes: 1024,
    durationMs: 120,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['host'], code: 'invalid_format' });
});

test('#AuditEntrySchema rejects a fractional status', () => {
  const result = AuditEntrySchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    secret: 'github-token',
    method: 'GET',
    host: 'api.github.com',
    path: '/user',
    status: 200.5,
    requestBytes: 0,
    responseBytes: 1024,
    durationMs: 120,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['status'], code: 'invalid_type' });
});

test.each(['requestBytes', 'responseBytes', 'durationMs'])(
  '#AuditEntrySchema rejects a negative %s',
  (field) => {
    const result = AuditEntrySchema.safeParse({
      at: new Date('2026-01-02T03:04:05.000Z'),
      imp: 'dev',
      secret: 'github-token',
      method: 'GET',
      host: 'api.github.com',
      path: '/user',
      status: 200,
      requestBytes: 0,
      responseBytes: 1024,
      durationMs: 120,
      [field]: -1,
    });

    expect(result.error?.issues).toPartiallyContain({ path: [field], code: 'too_small' });
  },
);
