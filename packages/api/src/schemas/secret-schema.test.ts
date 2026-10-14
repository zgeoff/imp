import { expect, test } from 'bun:test';
import {
  AuditEntrySchema,
  BrokerHostSchema,
  BrokerRuleSchema,
  GrantFilterSchema,
  GrantSchema,
  OAuthConfigSchema,
  RefusedRequestSchema,
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
    message: 'must be 1 to 64 printable characters, without a colon',
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

test('#RefusedRequestSchema accepts a tunnel the broker refused, to an IP address', () => {
  const payload = {
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    method: 'CONNECT',
    host: '10.0.0.1',
    path: null,
    status: 403,
    durationMs: 3,
    reason: 'address-refused',
  } as const;

  const result = RefusedRequestSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#RefusedRequestSchema accepts a refused head that named no method or host', () => {
  const payload = {
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    method: null,
    host: null,
    path: null,
    status: 400,
    durationMs: 1,
    reason: 'not-http',
  } as const;

  const result = RefusedRequestSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#RefusedRequestSchema rejects a reason it does not know', () => {
  const result = RefusedRequestSchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    method: 'CONNECT',
    host: 'example.com',
    path: null,
    status: 403,
    durationMs: 3,
    reason: 'because',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['reason'], code: 'invalid_value' });
});

test('#RefusedRequestSchema rejects a host longer than 253 characters', () => {
  const result = RefusedRequestSchema.safeParse({
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    method: 'CONNECT',
    host: 'a'.repeat(254),
    path: null,
    status: 403,
    durationMs: 3,
    reason: 'egress-policy',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['host'], code: 'too_big' });
});

test('#RefusedRequestSchema accepts a request refused outside a grant’s filter', () => {
  const payload = {
    at: new Date('2026-01-02T03:04:05.000Z'),
    imp: 'dev',
    method: 'DELETE',
    host: 'api.github.com',
    path: '/repos/a/b',
    status: 403,
    durationMs: 3,
    reason: 'outside-filter',
  } as const;

  expect(RefusedRequestSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#GrantFilterSchema accepts methods and paths', () => {
  const payload = {
    methods: ['GET', 'HEAD'],
    paths: ['/', '/v1/messages', '/repos/*/*/issues', '/v1/**', '/**', "/a-b_c.d~e!$&'()+,;=:@"],
  };

  expect(GrantFilterSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#GrantFilterSchema accepts methods alone', () => {
  expect(GrantFilterSchema.safeParse({ methods: ['GET'] }).data).toStrictEqual({
    methods: ['GET'],
  });
});

test('#GrantFilterSchema accepts paths alone', () => {
  expect(GrantFilterSchema.safeParse({ paths: ['/v1/**'] }).data).toStrictEqual({
    paths: ['/v1/**'],
  });
});

test('#GrantFilterSchema rejects a filter that names neither methods nor paths', () => {
  const result = GrantFilterSchema.safeParse({});

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message: 'must name methods, paths or both',
  });
});

test.each([['get'], ['G E T'], [''], ['ABCDEFGHIJKLMNOPQ']])(
  '#GrantFilterSchema rejects the method %p',
  (method) => {
    const result = GrantFilterSchema.safeParse({ methods: [method], paths: ['/v1/**'] });

    expect(result.error?.issues).toPartiallyContain({ path: ['methods', 0] });
  },
);

test.each([
  ['v1/messages'],
  [''],
  ['/v1/**/messages'],
  ['/v1/mess*ges'],
  ['/v1/***'],
  ['/v1/%2F'],
  ['/v1/messages?x=1'],
  ['/v1/messages#top'],
  ['/v1/a b'],
])('#GrantFilterSchema rejects the path pattern %p', (path) => {
  const result = GrantFilterSchema.safeParse({ methods: ['GET'], paths: [path] });

  expect(result.error?.issues).toPartiallyContain({ path: ['paths', 0] });
});

test('#GrantFilterSchema rejects a path pattern longer than 512 characters', () => {
  const result = GrantFilterSchema.safeParse({ paths: [`/${'a'.repeat(512)}`] });

  expect(result.error?.issues).toPartiallyContain({ path: ['paths', 0], code: 'too_big' });
});

test('#GrantFilterSchema rejects an empty list of methods', () => {
  const result = GrantFilterSchema.safeParse({ methods: [], paths: ['/v1/**'] });

  expect(result.error?.issues).toPartiallyContain({ path: ['methods'], code: 'too_small' });
});

test('#GrantFilterSchema rejects more than 64 path patterns', () => {
  const result = GrantFilterSchema.safeParse({
    paths: Array.from({ length: 65 }, (_, index) => `/p${index}`),
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['paths'], code: 'too_big' });
});

test('#GrantSchema accepts a grant without a filter', () => {
  const payload = { secret: 'gh', filter: null };

  expect(GrantSchema.safeParse(payload).data).toStrictEqual(payload);
});
