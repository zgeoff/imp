import { expect, test } from 'bun:test';
import {
  SecretRulesError,
  listPlaceholderEnv,
  renderCredential,
  resolveRules,
} from './connector-kinds';

test('the github preset uses Basic for git and a bearer token for the APIs', () => {
  const rules = resolveRules('github', undefined);
  const git = rules.find((rule) => rule.host === 'github.com');
  const api = rules.find((rule) => rule.host === 'api.github.com');
  const gitValue = git === undefined ? null : renderCredential(git, 'tok');
  const apiValue = api === undefined ? null : renderCredential(api, 'tok');

  expect(gitValue).toBe(`Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  expect(apiValue).toBe('Bearer tok');
});

test('anthropic sets x-api-key to the bare value', () => {
  const [rule] = resolveRules('anthropic', undefined);

  expect(rule).toMatchObject({ host: 'api.anthropic.com', header: 'x-api-key' });

  const value = rule === undefined ? null : renderCredential(rule, 'sk');

  expect(value).toBe('sk');
});

test('custom needs its own rules, one per host; presets refuse them', () => {
  const rule = { host: 'api.example.com', header: 'x-token', scheme: 'raw' } as const;

  expect(resolveRules('custom', [rule])).toEqual([rule]);
  expect(() => resolveRules('custom', undefined)).toThrow(SecretRulesError);

  expect(() => resolveRules('custom', [rule, { ...rule, header: 'x-other' }])).toThrow(
    'more than one rule',
  );

  expect(() => resolveRules('github', [rule])).toThrow(SecretRulesError);
});

test('placeholders come from the presets, each once', () => {
  expect(listPlaceholderEnv(['github', 'github', 'custom', 'anthropic'])).toEqual([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);
});
