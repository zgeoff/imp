import { expect, test } from 'bun:test';
import { OAuthConfigSchema } from '../secret-schema';
import { buildMockOAuthConfig } from './build-mock-oauth-config';

test('it builds a default oauth config', () => {
  const config = buildMockOAuthConfig();
  const parsed: unknown = OAuthConfigSchema.safeParse(config).data;
  const received: unknown = config;

  expect(received).toStrictEqual({
    tokenUrl: expect.stringMatching(/^https:\/\/[a-z0-9.-]+\/oauth\/token$/) as unknown,
    clientId: expect.stringMatching(/^[A-Za-z0-9]{16}$/) as unknown,
    tokenFormat: 'form',
  });

  expect(parsed).toStrictEqual(config);
});

test('it applies overrides on top of the defaults', () => {
  const config: unknown = buildMockOAuthConfig({
    tokenUrl: 'https://auth.example.com/oauth/token',
    tokenFormat: 'json',
  });

  expect(config).toStrictEqual({
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: expect.stringMatching(/^[A-Za-z0-9]{16}$/) as unknown,
    tokenFormat: 'json',
  });
});
