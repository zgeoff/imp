import { expect, test } from 'bun:test';
import { buildAgentOutdatedError, hasFeature } from './agent-outdated';

const VERSIONS = ['0.1.0', '0.1.9', '0.2.0', '0.2.5', '0.3.0', '0.10.1', '1.0.0', 'dev'];

test('sessions start with agent 0.2.0', () => {
  expect(VERSIONS.map((version) => hasFeature(version, 'sessions'))).toEqual([
    false,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
});

test('dial and sftp start with agent 0.3.0', () => {
  expect(VERSIONS.map((version) => hasFeature(version, 'ssh'))).toEqual([
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
});

test('an outer exec needs agent 0.16.0, and a version that is missing or does not parse fails', () => {
  const versions = [undefined, '', 'dev', '0.15.9', '0.16.0', '0.17.1', '1.0.0'];

  expect(versions.map((version) => hasFeature(version, 'outer-exec'))).toEqual([
    false,
    false,
    false,
    false,
    true,
    true,
    true,
  ]);

  expect(hasFeature(undefined, 'sessions')).toBe(true);
});

test('the outdated error tells the user to stop and start the imp', () => {
  const error = buildAgentOutdatedError('ssh');

  expect(error.code).toBe('AGENT_OUTDATED');

  expect(error.detail).toBe(
    "the imp's agent has no port forwarding or SFTP yet; stop and start the imp to update it",
  );
});
