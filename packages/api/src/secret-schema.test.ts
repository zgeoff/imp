import { expect, test } from 'bun:test';
import {
  BrokerRuleSchema,
  OAuthConfigSchema,
  SecretNameSchema,
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

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['upstream'], message }),
  );
});

test('#BrokerRuleSchema rejects an upstream longer than 2048 characters', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'svc.imp.internal',
    header: 'authorization',
    scheme: 'bearer',
    upstream: `https://${'a'.repeat(2048)}.example.com`,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['upstream'], code: 'too_big' }),
  );
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

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['host'],
      message: 'must be a lowercase hostname such as api.example.com',
    }),
  );
});

test('#BrokerRuleSchema rejects a rule whose header is not lowercase', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'Authorization',
    scheme: 'bearer',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['header'],
      message: 'must be a lowercase header name such as authorization',
    }),
  );
});

test('#BrokerRuleSchema rejects a rule with an unknown scheme', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'digest',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['scheme'] }));
});

test('#BrokerRuleSchema rejects a rule whose user holds a colon', () => {
  const result = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'basic',
    user: 'user:pass',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['user'], message: 'must be printable ASCII without a colon' }),
  );
});

test('#SecretNameSchema accepts a secret name that is a DNS label', () => {
  expect(SecretNameSchema.safeParse('gh-token').data).toBe('gh-token');
});

test('#SecretNameSchema rejects a secret name that could be a path', () => {
  const result = SecretNameSchema.safeParse('../token');

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: [],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#SecretValueSchema accepts a printable secret value', () => {
  expect(SecretValueSchema.safeParse('ghp_abc123').data).toBe('ghp_abc123');
});

test('#SecretValueSchema rejects a secret value with a line break', () => {
  const result = SecretValueSchema.safeParse('ghp_abc\r\nX-Other: 1');

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: [], message: 'must be printable ASCII without spaces' }),
  );
});

test('#SecretValueSchema rejects an empty secret value', () => {
  const result = SecretValueSchema.safeParse('');

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: [], code: 'too_small' }),
  );
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

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['tokenUrl'] }));
});

test('#OAuthConfigSchema rejects an oauth client id with a space', () => {
  const result = OAuthConfigSchema.safeParse({
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client 1',
    tokenFormat: 'json',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['clientId'],
      message: 'must be printable ASCII without spaces',
    }),
  );
});

test('#OAuthConfigSchema rejects an unknown oauth token format', () => {
  const result = OAuthConfigSchema.safeParse({
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client-1',
    tokenFormat: 'xml',
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['tokenFormat'] }),
  );
});
